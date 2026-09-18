import { basename, dirname, join } from 'node:path'
import { HOME, REGISTRY_DIR } from './paths.ts'
import { shellQuote } from './util.ts'
import type { BoardSession } from './types.ts'

/** The command to drop back into a session, ready to paste into any shell. */
export function buildResumeCommand(s: BoardSession): string {
  return `cd ${shellQuote(s.cwd)} && claude --resume ${s.resumeSessionId}`
}

/**
 * Render a path for the generated script, shortened to "$HOME/..." where it
 * helps. These paths are long enough to wrap the panel and make the command
 * hard to read, and everything the board deletes lives under ~/.claude.
 *
 * Only safe path remainders get the treatment: inside double quotes a `$`,
 * backtick, backslash or quote would be interpreted, so anything unusual falls
 * back to a fully single-quoted literal.
 */
function homePath(absolute: string): string {
  const rest = absolute.startsWith(HOME + '/') ? absolute.slice(HOME.length + 1) : null
  if (rest && /^[\w.\-/ ]+$/.test(rest)) return `"$HOME/${rest}"`
  return shellQuote(absolute)
}

/**
 * The shell variables both delete blocks are built on. Each block repeats them,
 * because the two are copied independently - a block that referred to variables
 * defined in the other one would run with them empty.
 */
function declarations(s: BoardSession): string[] {
  const lines: string[] = []
  if (s.jobId) lines.push(`JOB=${shellQuote(s.jobId)}`)
  else lines.push(`SESSION=${shellQuote(s.sessionId)}`)
  if (s.transcriptPath) {
    // The project directory gets its own line: the full path is ~110
    // characters and would wrap, which is what makes a command hard to read.
    lines.push(`PROJECT=${homePath(dirname(s.transcriptPath))}`)
    lines.push(`TRANSCRIPT="$PROJECT/${basename(s.transcriptPath)}"`)
  }
  return lines
}

/** What each block would remove, in the order it should happen. */
function removals(s: BoardSession): string[] {
  const out: string[] = []
  if (s.jobId) out.push('rm -rf "$HOME/.claude/jobs/${JOB:?}"')
  if (s.transcriptPath) out.push('rm -f "${TRANSCRIPT:?}"')
  return out
}

/**
 * A single guarded command that deletes the session, or refuses and says why.
 *
 * There is no `claude` subcommand for this - deletion lives only in the
 * interactive agents TUI - so this reproduces the guard that TUI applies and
 * leaves everything else alone. In particular it never touches the working
 * directory: unless a job made its own worktree (see `isolated`), the cwd is
 * your own checkout and none of Claude's git guards are in play.
 */
export function buildGuardedDelete(s: BoardSession): string {
  const drop = removals(s)
  if (drop.length === 0) return '# Nothing on disk to remove for this session.'

  // -E so the two-key alternation stays readable; inside double quotes the
  // parentheses and pipe are literal to the shell and alternation to grep.
  const grepArgs = s.jobId
    ? '-lE "\\"(jobId|parkedJobId)\\":\\"$JOB\\""'
    : '-l "\\"sessionId\\":\\"$SESSION\\""'
  const what = s.jobId ? 'job $JOB' : `session ${s.sessionId.slice(0, 8)}`

  return [
    ...declarations(s),
    '',
    'BUSY=$(',
    `  grep ${grepArgs} "$HOME"/.claude/sessions/*.json 2>/dev/null \\`,
    "    | sed 's#.*/##; s#\\.json$##' \\",
    '    | while read -r pid; do',
    '        ps -p "$pid" -o comm= 2>/dev/null | grep -qi claude \\',
    "          && printf '%s ' \"$pid\"",
    '      done',
    ')',
    '',
    'if [ -n "$BUSY" ]; then',
    `  echo "refusing: ${what} is still in use by pid(s): $BUSY"`,
    'else',
    ...drop.map((r) => `  ${r}`),
    `  echo "deleted ${what}"`,
    'fi',
  ].join('\n')
}

/** The same removals with no guard at all, for when you mean it. */
export function buildUnguardedDelete(s: BoardSession): string {
  const drop = removals(s)
  if (drop.length === 0) return '# Nothing on disk to remove for this session.'

  const lines = [...declarations(s), '']
  if (s.live && s.pid) {
    lines.push(`kill ${s.pid}   # the session is still running`)
    lines.push('')
  }
  // The :? guards abort rather than deleting the wrong thing if a variable
  // above was edited away - without JOB, the job removal would take every job.
  lines.push(...drop)
  return lines.join('\n')
}

export interface DeleteBlock {
  title: string
  note: string
  command: string
}

export interface DeletePanel {
  /** Shown once, above both blocks. */
  warnings: string[]
  blocks: DeleteBlock[]
}

/**
 * The delete panel: two independent options, each copied on its own. Nothing
 * here is ever executed by the board.
 */
export function buildDeletePanel(s: BoardSession): DeletePanel {
  const warnings: string[] = []

  if (s.needs) {
    warnings.push(
      `This job is blocked waiting on you - "${s.needs}" - but nothing is ` +
        'running, so the guard will not stop you.',
    )
  }
  if (s.isolated) {
    warnings.push(
      'This job made its own git worktree. Neither option removes it, and ' +
        'Claude will not notice it is orphaned. Use `claude agents` -> select ' +
        '-> ctrl+x instead, which removes the worktree and refuses if it holds ' +
        'uncommitted or unpushed work.',
    )
  }
  if (s.attachedPid) {
    warnings.push(
      `A terminal on ${s.where.label} (pid ${s.attachedPid}) is still attached ` +
        'to this job.',
    )
  }

  return {
    warnings,
    blocks: [
      {
        title: 'Guarded',
        note: 'Refuses while any live Claude process still holds this session - the same guard the agents view applies.',
        command: buildGuardedDelete(s),
      },
      {
        title: 'Unguarded',
        note: 'Removes it regardless. Use when you know nothing is running.',
        command: buildUnguardedDelete(s),
      },
    ],
  }
}

/**
 * One line per session for the bulk scripts: `<session-uuid> <job-id or ->`.
 *
 * Transcripts are matched by uuid glob rather than by full path - every
 * transcript is `projects/<slug>/<uuid>.jsonl`, and a uuid cannot glob onto
 * anything else, so this keeps the script short and readable where a list of
 * absolute paths would not be.
 */
function targetLines(sessions: BoardSession[]): string[] {
  return sessions
    .filter((s) => s.sessionId)
    .map((s) => `${s.sessionId} ${s.jobId ?? '-'}`)
}

function heredoc(lines: string[]): string[] {
  return ['done <<\'TARGETS\'', ...lines, 'TARGETS']
}

/**
 * Delete several sessions with one command, skipping any that are still in use.
 *
 * Same guard as the single-session version, applied per session: a bulk delete
 * is exactly where you least want to take out the session you happen to be
 * sitting in.
 */
export function buildBulkGuardedDelete(sessions: BoardSession[]): string {
  const targets = targetLines(sessions)
  if (targets.length === 0) return '# Nothing selected.'

  return [
    'while read -r SESSION JOB; do',
    '  [ -n "$SESSION" ] || continue',
    '',
    '  BUSY=$(',
    '    grep -lE "\\"(sessionId|jobId|parkedJobId)\\":\\"($SESSION|$JOB)\\"" \\',
    '         "$HOME"/.claude/sessions/*.json 2>/dev/null \\',
    "      | sed 's#.*/##; s#\\.json$##' \\",
    '      | while read -r pid; do',
    '          ps -p "$pid" -o comm= 2>/dev/null | grep -qi claude \\',
    "            && printf '%s ' \"$pid\"",
    '        done',
    '  )',
    '',
    '  if [ -n "$BUSY" ]; then',
    '    echo "skipped  $SESSION - in use by pid(s): $BUSY"',
    '    continue',
    '  fi',
    '',
    '  rm -f "$HOME"/.claude/projects/*/"$SESSION".jsonl',
    '  [ "$JOB" = "-" ] || rm -rf "$HOME/.claude/jobs/$JOB"',
    '  echo "deleted  $SESSION"',
    ...heredoc(targets),
  ].join('\n')
}

/** The same removals with no guard at all, for when you mean it. */
export function buildBulkUnguardedDelete(sessions: BoardSession[]): string {
  const targets = targetLines(sessions)
  if (targets.length === 0) return '# Nothing selected.'

  return [
    'while read -r SESSION JOB; do',
    '  [ -n "$SESSION" ] || continue',
    '  rm -f "$HOME"/.claude/projects/*/"$SESSION".jsonl',
    '  [ "$JOB" = "-" ] || rm -rf "$HOME/.claude/jobs/$JOB"',
    '  echo "deleted  $SESSION"',
    ...heredoc(targets),
  ].join('\n')
}

/** The delete panel for a multi-session selection. */
export function buildBulkDeletePanel(sessions: BoardSession[]): DeletePanel {
  const warnings: string[] = []

  const live = sessions.filter((s) => s.live)
  if (live.length > 0) {
    warnings.push(
      `${live.length} of these ${live.length === 1 ? 'is' : 'are'} still running ` +
        `(${live.map((s) => s.title).slice(0, 3).join(', ')}` +
        `${live.length > 3 ? ', …' : ''}). The guarded option skips those; the ` +
        'unguarded one will delete them out from under you.',
    )
  }

  const isolated = sessions.filter((s) => s.isolated)
  if (isolated.length > 0) {
    warnings.push(
      `${isolated.length} made their own git worktree. Neither option removes ` +
        'those worktrees, and Claude will not notice they are orphaned.',
    )
  }

  const noun = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`
  return {
    warnings,
    blocks: [
      {
        title: `Guarded · ${noun}`,
        note: 'Skips any session a live Claude process still holds, and says which.',
        command: buildBulkGuardedDelete(sessions),
      },
      {
        title: `Unguarded · ${noun}`,
        note: 'Removes all of them regardless.',
        command: buildBulkUnguardedDelete(sessions),
      },
    ],
  }
}

/** Exposed for tests: where the guard looks for live holders. */
export const REGISTRY_GLOB = join(REGISTRY_DIR, '*.json')
