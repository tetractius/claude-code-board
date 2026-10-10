import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BOARD_DIR, CLAUDE_DIR, HOOKS_DIR } from './paths.ts'
import { readJson } from './util.ts'
import type { Status } from './types.ts'

/**
 * Session status from Claude Code hooks.
 *
 * Every other status source is Claude's private on-disk state, which has
 * already changed under the board twice (see AGENTS.md). Hooks are a documented
 * interface: Claude runs a command on each event and passes the session id on
 * stdin. The board's hook writes one small file per session, so status no
 * longer depends on where Claude keeps its own.
 *
 * Opt-in: installing means editing `~/.claude/settings.json`, which is the
 * user's file, so it only ever happens from the button in Settings.
 */

export const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json')
const SCRIPT_FILE = join(BOARD_DIR, 'hook.sh')

/** Identifies our entries in settings.json, so uninstall removes only those. */
const MARKER = '# claude-code-board'
const COMMAND = `sh "$HOME/.claude-board/hook.sh" ${MARKER}`

const EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const

/*
 * Plain sh and sed, so it needs nothing that may not be installed. It keeps
 * only the event, whether a notification is a permission request, and the
 * time: the prompt text in the hook's input never reaches disk. Claude sends
 * compact single-line JSON, which is what makes the sed extraction safe.
 */
const SCRIPT = `#!/bin/sh
# Written by Claude Code Board. Records the last hook event per session.
d="$HOME/.claude-board/hooks"
i=$(cat)
s=$(printf '%s' "$i" | sed -n 's/.*"session_id" *: *"\\([0-9a-f-]*\\)".*/\\1/p')
e=$(printf '%s' "$i" | sed -n 's/.*"hook_event_name" *: *"\\([A-Za-z]*\\)".*/\\1/p')
[ -n "$s" ] && [ -n "$e" ] || exit 0
if [ "$e" = SessionEnd ]; then rm -f "$d/$s.json"; exit 0; fi
k=
[ "$e" = Notification ] && case "$i" in *permission*) k=permission ;; esac
mkdir -p "$d"
printf '{"event":"%s","kind":"%s","at":%s000}\\n' "$e" "$k" "$(date +%s)" > "$d/$s.json.tmp" \\
  && mv "$d/$s.json.tmp" "$d/$s.json"
exit 0
`

interface HookRecord {
  event: string
  kind: string
  at: number
}

export interface HookStatus {
  status: Status
  at: number
  waitingFor?: string
}

/**
 * Last hook-reported status for a session, or null if the hooks have never
 * fired for it.
 *
 * Hooks do not fire when a permission prompt is answered, so a "waiting"
 * record would outlive the prompt until the turn ends. A transcript write after
 * the notification means work resumed, so that reads as busy.
 */
export async function readHookStatus(
  sessionId: string,
  transcriptAt?: number,
): Promise<HookStatus | null> {
  if (!sessionId) return null
  const r = await readJson<HookRecord>(join(HOOKS_DIR, `${sessionId}.json`))
  if (!r?.event || !r.at) return null
  switch (r.event) {
    case 'UserPromptSubmit':
      return { status: 'busy', at: r.at }
    case 'Notification':
      if (r.kind !== 'permission') return { status: 'idle', at: r.at }
      // A second's slack: the notification and its transcript record land together.
      if (transcriptAt && transcriptAt > r.at + 1000) return { status: 'busy', at: transcriptAt }
      return { status: 'waiting', at: r.at, waitingFor: 'permission' }
    case 'Stop':
      return { status: 'idle', at: r.at }
    default:
      return null
  }
}

type HookEntry = { matcher?: string; hooks?: { type?: string; command?: string }[] }
type Settings = { hooks?: Record<string, HookEntry[]> } & Record<string, unknown>

const ours = (e: HookEntry) => !!e.hooks?.some((h) => h.command?.includes(MARKER))

/**
 * Throws rather than returning `{}` when the file exists but does not parse:
 * writing back a fresh object would wipe the user's settings.
 */
async function readSettings(): Promise<Settings> {
  let raw: string
  try {
    raw = await readFile(SETTINGS_FILE, 'utf8')
  } catch {
    return {}
  }
  try {
    return JSON.parse(raw) as Settings
  } catch {
    throw new Error(`${SETTINGS_FILE} is not valid JSON, so it was left untouched.`)
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await mkdir(CLAUDE_DIR, { recursive: true })
  // One backup per change, next to the original, for a manual rollback.
  await copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.board-backup`).catch(() => {})
  const tmp = `${SETTINGS_FILE}.board-tmp`
  await writeFile(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  await copyFile(tmp, SETTINGS_FILE)
  await rm(tmp, { force: true })
}

export async function hooksInstalled(): Promise<boolean> {
  const { hooks } = await readSettings().catch(() => ({}) as Settings)
  return EVENTS.every((e) => hooks?.[e]?.some(ours))
}

export async function installHooks(): Promise<void> {
  const settings = await readSettings()
  await mkdir(HOOKS_DIR, { recursive: true })
  await writeFile(SCRIPT_FILE, SCRIPT, 'utf8')
  await chmod(SCRIPT_FILE, 0o755)

  const hooks = (settings.hooks ??= {})
  for (const event of EVENTS) {
    const list = (hooks[event] ??= [])
    if (!list.some(ours)) list.push({ hooks: [{ type: 'command', command: COMMAND }] })
  }
  await writeSettings(settings)
}

export async function uninstallHooks(): Promise<void> {
  const settings = await readSettings()
  const hooks = settings.hooks
  if (hooks) {
    for (const event of Object.keys(hooks)) {
      hooks[event] = hooks[event].filter((e) => !ours(e))
      if (hooks[event].length === 0) delete hooks[event]
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks
    await writeSettings(settings)
  }
  // Stale records would otherwise keep overriding live status.
  for (const f of await readdir(HOOKS_DIR).catch(() => [] as string[])) {
    await rm(join(HOOKS_DIR, f), { force: true })
  }
}

export { SCRIPT as HOOK_SCRIPT, COMMAND as HOOK_COMMAND }
