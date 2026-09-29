import { execFile as execFileCb } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
import { REGISTRY_DIR } from './paths.ts'
import { readJson } from './util.ts'

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
  isAlive: (pid: number) => boolean,
  transcripts: Map<string, string>,
): Promise<{ pid: number; cwd: string; sessionId: string }[]> {
  let files: string[]
  try {
    files = await readdir(REGISTRY_DIR)
  } catch {
    return []
  }

  const pids = files
    .map((f) => Number(f.split('.')[0]))
    .filter((pid) => Number.isInteger(pid) && isAlive(pid))

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

  const claimed = new Set<string>()
  const out: { pid: number; cwd: string; sessionId: string }[] = []
  for (const pid of pids) {
    const cwd = await cwdOf(pid)
    if (!cwd) continue
    const slug = slugifyCwd(cwd)
    const match = byMtime.find(
      (t) => !claimed.has(t.sessionId) && basename(dirname(t.path)) === slug,
    )
    if (!match) continue
    claimed.add(match.sessionId)
    out.push({ pid, cwd, sessionId: match.sessionId })
  }
  return out
}

/** The project directory name Claude derives from a cwd: `/` and `_` both become `-`. */
export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[/_]/g, '-')
}

async function cwdOf(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
    const line = stdout.split('\n').find((l) => l.startsWith('n/'))
    return line ? line.slice(1) : null
  } catch {
    return null
  }
}
