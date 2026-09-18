import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
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
