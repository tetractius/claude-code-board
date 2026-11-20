import { execFile as execFileCb } from 'node:child_process'
import { readdir, readlink, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
import { PROJECTS_DIR, REGISTRY_DIR } from './paths.ts'
import { continuesLatest, isClaudeProcess, resumedSessionId, type ProcInfo } from './ps.ts'
import { readJson } from './util.ts'

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `ps` gives start times to the second; a file is never older than its writer by more. */
const START_SLACK_MS = 2_000

/** A `~/.claude/sessions/<pid>.json` record. */
export interface RegistryEntry {
  pid?: number
  sessionId?: string
  cwd?: string
  startedAt?: number
  procStart?: string
  version?: string
  kind?: 'interactive' | 'bg'
  entrypoint?: 'cli' | 'claude-desktop' | string
  name?: string
  nameSource?: 'user' | 'derived' | 'auto' | string
  nameSince?: number
  updatedAt?: number
  status?: 'idle' | 'busy' | 'waiting'
  statusUpdatedAt?: number
  waitingFor?: string
  jobId?: string
  parkedJobId?: string
  formerNames?: { name: string; until: number }[]
}

export function readRegistry(pid: number): Promise<RegistryEntry | null> {
  return readJson<RegistryEntry>(join(REGISTRY_DIR, `${pid}.json`))
}

/**
 * Every entry in the live session registry.
 *
 * `claude agents --json` deliberately withholds two kinds of entry: sessions
 * parked on a background job, and background workers carrying a jobId. Both are
 * real, running sessions, so the board needs the raw registry to know they
 * exist - otherwise it either mislabels them or resurrects them from their
 * transcript as "exited" while they are plainly still running.
 */
export async function readAllRegistry(): Promise<RegistryEntry[]> {
  let files: string[]
  try {
    files = await readdir(REGISTRY_DIR)
  } catch {
    return []
  }
  const entries = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<RegistryEntry>(join(REGISTRY_DIR, f))),
  )
  return entries.filter((e): e is RegistryEntry => !!e?.pid)
}

/**
 * Live interactive sessions, discovered without the registry.
 *
 * Claude 2.1.28x stopped writing `~/.claude/sessions/<pid>.json` and stopped
 * listing interactive sessions in `claude agents --json`, so neither source
 * knows they exist any more. What is left: a `<pid>.<hash>.key` per live
 * session, `lsof` for its working directory, and the newest transcript in that
 * directory's project folder - the file the session is appending to.
 *
 * Status, name and entrypoint are simply gone for these; the transcript
 * supplies the title and the activity time, and the status shows as unknown.
 */
export async function discoverLiveSessions(
  procs: Map<number, ProcInfo>,
  transcripts: Map<string, string>,
): Promise<{ pid: number; cwd: string; sessionId: string }[]> {
  let files: string[]
  try {
    files = await readdir(REGISTRY_DIR)
  } catch {
    return []
  }

  const isAlive = (pid: number) => isClaudeProcess(procs.get(pid))
  const pids = [
    ...new Set(
      files
        .map((f) => Number(f.split('.')[0]))
        .filter((pid) => Number.isInteger(pid) && isAlive(pid)),
    ),
  ]

  // Newest transcript first, so each cwd's most recent one is claimed first and
  // two sessions in the same directory do not both match the same file.
  const byMtime = await Promise.all(
    [...transcripts].map(async ([sessionId, path]) => ({
      sessionId,
      path,
      mtimeMs: await stat(path).then((s) => s.mtimeMs, () => 0),
    })),
  )
  byMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)

  /**
   * Session directories - `projects/<slug>/<uuid>/`, holding subagents and
   * tool results - appear as soon as a session does something, while its
   * transcript may not be written until much later. For a session started as a
   * bare `claude` this is often the only place its id exists on disk.
   */
  const sessionDirs = async (slug: string) => {
    try {
      const entries = await readdir(join(PROJECTS_DIR, slug), { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory() && UUID_NAME.test(e.name))
      return (
        await Promise.all(
          dirs.map(async (e) => ({
            sessionId: e.name,
            mtimeMs: await stat(join(PROJECTS_DIR, slug, e.name)).then(
              (s) => s.mtimeMs,
              () => 0,
            ),
          })),
        )
      ).sort((a, b) => b.mtimeMs - a.mtimeMs)
    } catch {
      return []
    }
  }

  /**
   * Every session this project has on disk, by when it was last written to:
   * its transcript, its session directory, whichever is newer. Taking either
   * kind on its own picks wrong - a session that has not used a subagent yet
   * has no directory, and the newest directory is then some older session's,
   * which the card would show, title and context and all, for as long as the
   * live one ran.
   */
  const inProject = async (slug: string) => {
    const latest = new Map<string, number>()
    const seen = (id: string, mtimeMs: number) =>
      latest.set(id, Math.max(latest.get(id) ?? 0, mtimeMs))
    for (const t of byMtime) if (basename(dirname(t.path)) === slug) seen(t.sessionId, t.mtimeMs)
    for (const d of await sessionDirs(slug)) seen(d.sessionId, d.mtimeMs)
    return [...latest]
      .map(([sessionId, mtimeMs]) => ({ sessionId, mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  const claimed = new Set<string>()
  const out: { pid: number; cwd: string; sessionId: string }[] = []
  for (const pid of pids) {
    const cwd = await cwdOf(pid)
    if (!cwd) continue
    const slug = slugifyCwd(cwd)
    const proc = procs.get(pid)

    /*
     * Exact first, guesswork last. `--resume <uuid>` is authoritative and is
     * deliberately not subject to `claimed`: two terminals resuming the same
     * session must both resolve to it, and the caller collapses them into one
     * card.
     */
    let sessionId = resumedSessionId(proc)

    /*
     * Otherwise the project's most recent session - but only one written to
     * since this process started. Anything older belongs to an earlier run,
     * and a session that has not written yet is better shown unnamed than as
     * that one. `--continue` is the exception: it picks up exactly that
     * session, which was last written before it started.
     */
    const since = continuesLatest(proc) || !proc?.startedAt ? 0 : proc.startedAt - START_SLACK_MS
    sessionId ??= (await inProject(slug)).find(
      (c) => !claimed.has(c.sessionId) && c.mtimeMs >= since,
    )?.sessionId

    // Still unknown: show the session anyway. A card with no id is far more
    // use than a running session missing from the board entirely.
    if (sessionId) claimed.add(sessionId)
    out.push({ pid, cwd, sessionId: sessionId ?? '' })
  }
  return out
}

/** The project directory name Claude derives from a cwd: `/` and `_` both become `-`. */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[/_]/g, '-')
}

async function cwdOf(pid: number): Promise<string | null> {
  // Linux has it as a symlink, with no process to spawn and no dependency on
  // lsof being installed - which it often is not on a minimal system.
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`)
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n/'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}
