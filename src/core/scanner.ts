import { basename } from 'node:path'
import { listAgents, resolveClaudeBin, type AgentEntry } from './claudeCli.ts'
import { readAllRegistry, readRegistry, type RegistryEntry } from './registry.ts'
import { readJobState, type JobState } from './jobs.ts'
import { buildTranscriptIndex, readTranscriptMeta, pruneTranscriptCache } from './transcripts.ts'
import { buildHistoryIndex } from './history.ts'
import { buildProcIndex, isClaudeProcess, type ProcInfo } from './ps.ts'
import { resolveActivity } from './activity.ts'
import { compareVersions, toMs } from './util.ts'
import { TERMINAL_STATUS, NEEDS_ATTENTION } from './types.ts'
import type { BoardSession, ScanResult, Status, Where } from './types.ts'

/** The CLI appends this to a session's name to mark it as forked. */
const FORK_MARK = '⑂'

function stripFork(name: string): string {
  // Removing the mark from the middle of a name leaves a double space behind.
  return name.replace(FORK_MARK, '').replace(/\s+/g, ' ').trim()
}

/**
 * Live sessions carry `status`, background jobs carry `state`, and a background
 * job whose worker is still alive carries both. Claude Desktop sessions publish
 * neither.
 *
 * The subtle case is a background job whose run has finished while you are sat
 * in it: `state` stays "done" describing that last batch run, but you have
 * attached a terminal and are prompting it again. Reporting "done" there is
 * wrong twice over - it mislabels a session you are using, and it files it
 * under finished, hiding it behind the toggle. So when a terminal is attached
 * and alive, its own live status wins.
 */
function deriveStatus(entry: AgentEntry, live: boolean, attached: RegistryEntry | null): Status {
  if (entry.kind === 'background' && entry.state) {
    if (TERMINAL_STATUS.has(entry.state) && attached?.status) return attached.status
    return entry.state
  }
  if (entry.status) return entry.status
  if (!live) return 'exited'
  return 'unknown'
}

function ttyOf(proc: ProcInfo | undefined): string | null {
  if (!proc || !isClaudeProcess(proc)) return null
  const { tty } = proc
  return tty && tty !== '??' && tty !== '-' ? tty : null
}

/**
 * Where you would actually go to look at this session.
 *
 * A background job's own worker never has a terminal, but if an interactive
 * session is parked on that job then the job IS on screen, in that session's
 * terminal - so the attached tty is checked before falling back to calling it
 * "background". Getting this wrong labels a session you are staring at in iTerm
 * as a headless background job.
 */
function deriveWhere(
  kind: string,
  proc: ProcInfo | undefined,
  entrypoint: string | undefined,
  attached: ProcInfo | undefined,
): Where {
  const own = ttyOf(proc)
  if (own) return { type: 'tty', label: own }

  const viaAttached = ttyOf(attached)
  if (viaAttached) return { type: 'tty', label: viaAttached }

  if (kind === 'background') return { type: 'background', label: 'background' }

  /*
   * Anything hosting a session that is not a terminal identifies itself as
   * `claude-<host>`: `claude-desktop`, `claude-vscode`, and presumably more to
   * come. Deriving the label from the suffix means a new front end shows up
   * named rather than as an anonymous dash.
   */
  if (entrypoint === 'sdk-cli') return { type: 'headless', label: 'headless' }

  const host = /^claude-(.+)$/.exec(entrypoint ?? '')
  if (host) return { type: 'host', label: host[1] }

  return { type: 'none', label: '—' }
}

async function buildSession(
  entry: AgentEntry,
  ctx: {
    transcripts: Map<string, string>
    history: Map<string, number>
    procs: Map<number, ProcInfo>
    /** Interactive sessions parked on a background job, keyed by job id. */
    parked: Map<string, RegistryEntry>
    /** Version of the installed binary, for the restart-needed check. */
    installed: string
  },
): Promise<BoardSession> {
  const sessionId = entry.sessionId ?? ''
  const pid = entry.pid
  const proc = pid === undefined ? undefined : ctx.procs.get(pid)
  const live = pid !== undefined && isClaudeProcess(proc)

  const [registry, job] = await Promise.all([
    pid === undefined ? Promise.resolve(null) : readRegistry(pid),
    entry.id ? readJobState(entry.id) : Promise.resolve<JobState | null>(null),
  ])

  // The terminal a parked interactive session is showing this job in.
  const parked = entry.id ? ctx.parked.get(entry.id) : undefined
  const attachedProc = parked?.pid === undefined ? undefined : ctx.procs.get(parked.pid)
  // Only trust a parked entry whose process is genuinely still a live claude.
  const attached = isClaudeProcess(attachedProc) ? (parked ?? null) : null

  const transcriptPath = sessionId ? ctx.transcripts.get(sessionId) : undefined
  const meta = transcriptPath ? await readTranscriptMeta(transcriptPath) : null

  /*
   * Title precedence, matching what Claude's own front ends show.
   *
   * A /rename wins: it is written into the transcript as a custom-title, and
   * unlike the registry entry it survives the process. Next comes a name that
   * was actually chosen - `nameSource: "derived"` marks the ones Claude
   * generated from the directory, like "hive-mono-26", which are worse than
   * useless on a board full of sessions from the same repo. Then the model's
   * own title: that is what the VS Code session list displays, so preferring it
   * over a derived name keeps the two in agreement.
   */
  const rawName = entry.name || registry?.name || job?.name || ''
  const reported = stripFork(rawName)
  const derived = (registry?.nameSource ?? job?.nameSource) === 'derived'
  const title =
    stripFork(meta?.customTitle ?? '') ||
    (derived ? '' : reported) ||
    meta?.aiTitle ||
    reported ||
    basename(entry.cwd ?? '') ||
    'untitled'

  const activity = resolveActivity({
    registryUpdatedAt: Math.max(registry?.statusUpdatedAt ?? 0, registry?.updatedAt ?? 0),
    jobUpdatedAt: toMs(job?.updatedAt),
    transcriptAt: meta?.lastMessageAt,
    historyAt: ctx.history.get(sessionId),
    startedAt: entry.startedAt,
    transcriptMtime: meta?.mtimeMs,
  })

  const entrypoint = registry?.entrypoint ?? meta?.entrypoint
  const status = deriveStatus(entry, live, attached)

  // A running process keeps executing the build it started with, so an update
  // installed underneath it does nothing until it restarts. Only flag sessions
  // strictly behind the installed build - a newer one means we resolved a
  // different install than the session was launched from.
  const version = registry?.version
  // A finished background job whose worker is still alive is not something you
  // restart, so terminal states are excluded even though they have a process.
  const needsRestart =
    live &&
    !TERMINAL_STATUS.has(status) &&
    !!version &&
    !!ctx.installed &&
    compareVersions(version, ctx.installed) < 0

  return {
    key: `${entry.kind ?? 'interactive'}:${entry.id ?? pid ?? sessionId}`,
    sessionId,
    resumeSessionId: job?.resumeSessionId || sessionId,
    jobId: entry.id,
    pid,
    kind: entry.kind === 'background' ? 'background' : 'interactive',
    cwd: entry.cwd ?? job?.cwd ?? '?',
    where: deriveWhere(entry.kind ?? 'interactive', proc, entrypoint, attachedProc),
    attachedPid: attached?.pid,
    entrypoint,
    headless: entrypoint === 'sdk-cli',
    command: meta?.command,
    title,
    nameSource: registry?.nameSource ?? job?.nameSource,
    isFork: rawName.includes(FORK_MARK) || !!job?.forkParentSessionId,
    forkParentSessionId: job?.forkParentSessionId,
    status,
    // Preserved separately: the job's own last outcome is still worth showing
    // even when the attached terminal's live status is what the badge reports.
    jobState: entry.state,
    isolated: !!job?.bgIsolation && job.bgIsolation !== 'none',
    waitingFor: entry.waitingFor ?? registry?.waitingFor ?? attached?.waitingFor,
    live,
    startedAt: entry.startedAt ?? 0,
    lastActivity: activity.at,
    lastActivitySource: activity.source,
    lastPrompt: meta?.lastPrompt,
    detail: job?.detail,
    needs: NEEDS_ATTENTION.has(status) ? job?.needs : undefined,
    suggestedReply: job?.suggestedReply,
    // state.json stores an explicit null when a job has no linked children.
    children: job?.children ?? undefined,
    tokens: job?.tokens,
    transcriptPath,
    version,
    needsRestart,
  }
}

/**
 * Sessions the CLI no longer reports at all: finished interactive ones whose
 * transcript is still on disk waiting to be collected. Recovered the same way
 * `claude-sessions` does it - everything in the transcript index that the
 * agents listing did not account for.
 */
async function recoverFinished(
  transcripts: Map<string, string>,
  seen: Set<string>,
  history: Map<string, number>,
): Promise<BoardSession[]> {
  const out: BoardSession[] = []
  for (const [sessionId, path] of transcripts) {
    if (seen.has(sessionId)) continue
    const meta = await readTranscriptMeta(path, { wantCwd: true })
    if (!meta) continue
    const cwd = meta.cwd ?? '?'
    const activity = resolveActivity({
      transcriptAt: meta.lastMessageAt,
      historyAt: history.get(sessionId),
      transcriptMtime: meta.mtimeMs,
    })
    out.push({
      key: `interactive:${sessionId}`,
      sessionId,
      resumeSessionId: sessionId,
      kind: 'interactive',
      cwd,
      where: deriveWhere('interactive', undefined, meta.entrypoint, undefined),
      entrypoint: meta.entrypoint,
      headless: meta.entrypoint === 'sdk-cli',
      command: meta.command,
      // Same order as a live session: the rename outlives the process.
      title: stripFork(meta.customTitle ?? '') || meta.aiTitle || basename(cwd) || 'untitled',
      isFork: false,
      status: 'exited',
      live: false,
      startedAt: 0,
      lastActivity: activity.at,
      lastActivitySource: activity.source,
      lastPrompt: meta.lastPrompt,
      transcriptPath: path,
      needsRestart: false,
    })
  }
  return out
}

/**
 * Sessions that need a human come first, then everything still running, then
 * the dead - each group most-recently-active first.
 */
function rank(s: BoardSession): number {
  if (NEEDS_ATTENTION.has(s.status)) return 0
  if (!TERMINAL_STATUS.has(s.status)) return 1
  return 2
}

export interface ScanOptions {
  claudeBin?: string
  /** Max finished sessions to return; 0 means no limit. */
  finishedLimit?: number
}

/** The single entry point. Safe to call from Electron's main process or a server. */
export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const scannedAt = Date.now()

  let bin
  try {
    bin = await resolveClaudeBin(opts.claudeBin ?? '')
  } catch (err) {
    return { sessions: [], scannedAt, error: (err as Error).message }
  }

  let entries: AgentEntry[]
  try {
    entries = await listAgents(bin.path)
  } catch (err) {
    return {
      sessions: [],
      scannedAt,
      claudeBin: bin.path,
      claudeVersion: bin.version,
      error: `\`claude agents --json --all\` failed: ${(err as Error).message}`,
    }
  }

  const [transcripts, history, procs, registry] = await Promise.all([
    buildTranscriptIndex(),
    buildHistoryIndex(),
    buildProcIndex(),
    readAllRegistry(),
  ])

  // Only registry entries backed by a live claude process count; the directory
  // accumulates records for pids that exited long ago.
  const alive = registry.filter((e) => isClaudeProcess(procs.get(e.pid!)))
  const parked = new Map<string, RegistryEntry>()
  for (const e of alive) if (e.parkedJobId) parked.set(e.parkedJobId, e)
  const liveSessionIds = new Set(alive.map((e) => e.sessionId).filter(Boolean) as string[])
  pruneTranscriptCache(new Set(transcripts.values()))

  const sessions = await Promise.all(
    entries.map((entry) =>
      buildSession(entry, { transcripts, history, procs, parked, installed: bin.semver }),
    ),
  )

  /*
   * Recovery is for sessions with no process left. Session ids the registry
   * still holds a live process for must be excluded, or a session the CLI
   * deliberately hid - a parked terminal, a background worker - gets raised
   * from its transcript and shown as "exited" while it is running.
   */
  const seen = new Set([
    ...sessions.map((s) => s.sessionId).filter(Boolean),
    ...liveSessionIds,
  ])
  sessions.push(...(await recoverFinished(transcripts, seen, history)))

  sessions.sort((a, b) => rank(a) - rank(b) || b.lastActivity - a.lastActivity)

  // Trim finished sessions only, and only after sorting, so the ones kept are
  // always the most recent.
  const limit = opts.finishedLimit ?? 0
  if (limit > 0) {
    let dropped = 0
    const kept = sessions.filter((s) => {
      if (!TERMINAL_STATUS.has(s.status)) return true
      return ++dropped <= limit
    })
    return {
      sessions: kept,
      scannedAt,
      claudeBin: bin.path,
      claudeVersion: bin.version,
    }
  }

  return { sessions, scannedAt, claudeBin: bin.path, claudeVersion: bin.version }
}
