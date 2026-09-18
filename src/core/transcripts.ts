import { readdir, stat, open } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECTS_DIR } from './paths.ts'

export interface TranscriptMeta {
  path: string
  mtimeMs: number
  size: number
  /**
   * The title you set with /rename, from the last {"type":"custom-title"}
   * record. This is the authoritative name: `agents --json` may report a
   * derived one, and once a session is over the registry entry is gone and the
   * transcript is the only place the rename survives.
   */
  customTitle?: string
  /** The model-generated title, from the last {"type":"ai-title"} record. */
  aiTitle?: string
  /** The last user prompt, from the last {"type":"last-prompt"} record. */
  lastPrompt?: string
  /** Working directory, recovered from the first record that carries one. */
  cwd?: string
  /**
   * When the last actual message was written, in epoch ms. The only activity
   * signal for a session whose host publishes no status - VS Code and the
   * desktop app - and which never writes to history.jsonl either.
   */
  lastMessageAt?: number
  /**
   * Which front end wrote this transcript: `cli` for a terminal, `claude-vscode`
   * or `claude-desktop` for an editor or the app, and `sdk-cli` for a headless
   * `claude -p` run. Read from the transcript rather than the registry because
   * a headless run's registry entry is gone the moment it exits.
   */
  entrypoint?: string
  /** The slash command a session opened with, e.g. `/daily-standup`. */
  command?: string
}

const TAIL_BYTES = 512 * 1024
const HEAD_BYTES = 64 * 1024
/** Refuse to whole-file scan anything larger than this. */
const MAX_FULL_SCAN = 32 * 1024 * 1024

/**
 * Transcripts are rewritten wholesale by Claude's compaction pass, so the cache
 * key includes size and mtime - a rewrite invalidates the entry even when the
 * conversation itself did not change.
 */
const cache = new Map<string, TranscriptMeta>()

/**
 * Map session uuid -> transcript path.
 *
 * The project directory name is a slugified cwd, but the slug is lossy (both
 * `/` and `_` become `-`), so it can never be reversed. Indexing by the uuid in
 * the filename is the only reliable join.
 */
export async function buildTranscriptIndex(): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  let dirs: string[]
  try {
    dirs = await readdir(PROJECTS_DIR)
  } catch {
    return index
  }
  await Promise.all(
    dirs.map(async (dir) => {
      const full = join(PROJECTS_DIR, dir)
      let files: string[]
      try {
        files = await readdir(full)
      } catch {
        return
      }
      for (const file of files) {
        if (file.endsWith('.jsonl')) index.set(file.slice(0, -6), join(full, file))
      }
    }),
  )
  return index
}

/** Read `length` bytes from `position`, tolerating short files. */
async function readSlice(path: string, position: number, length: number): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const start = Math.max(0, position)
    const buf = Buffer.allocUnsafe(Math.max(0, length))
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/**
 * Pull the value of `field` out of the last JSONL record of the given `type`.
 * Records of both kinds are appended repeatedly as a session runs, so the last
 * one wins - the same tail-then-fallback approach `claude-sessions` uses.
 */
function lastRecord(blob: string, type: string, field: string): string | undefined {
  const marker = `"type":"${type}"`
  let at = blob.lastIndexOf(marker)
  while (at >= 0) {
    const start = blob.lastIndexOf('\n', at) + 1
    const end = blob.indexOf('\n', at)
    const line = end === -1 ? blob.slice(start) : blob.slice(start, end)
    try {
      const value = JSON.parse(line)[field]
      if (typeof value === 'string' && value) return value
    } catch {
      // A truncated first line in the tail window; keep walking backwards.
    }
    at = blob.lastIndexOf(marker, at - 1)
  }
  return undefined
}

/**
 * The timestamp of the last real message.
 *
 * Walks backwards, because a transcript almost always ends with metadata
 * records - `ai-title`, `last-prompt`, `custom-title` - that carry no timestamp
 * at all. Only `user` and `assistant` entries do, in ISO-8601.
 */
function lastMessageAt(blob: string): number | undefined {
  const lines = blob.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"timestamp"')) continue
    try {
      const ts = Date.parse(JSON.parse(lines[i]).timestamp)
      if (!Number.isNaN(ts)) return ts
    } catch {
      // A truncated first line of the tail window.
    }
  }
  return undefined
}

/**
 * Pull `field` out of the first record in the blob that carries it.
 * Used on the head of a file, where the opening records are.
 */
function firstField(blob: string, field: string): string | undefined {
  for (const line of blob.split('\n')) {
    if (!line.includes(`"${field}"`)) continue
    try {
      const value = JSON.parse(line)[field]
      if (typeof value === 'string' && value) return value
    } catch {
      // Partial line at the end of the head window.
    }
  }
  return undefined
}

/**
 * The slash command a session was started with, if any.
 *
 * A session launched as `claude -p "/daily-standup draft"` records that as its
 * first user message, wrapped in the same <command-name> markers the CLI uses
 * for any local command.
 */
function firstCommand(blob: string): string | undefined {
  const at = blob.indexOf('<command-name>')
  if (at === -1) return undefined
  const end = blob.indexOf('</command-name>', at)
  if (end === -1) return undefined
  const name = blob.slice(at + 14, end).trim()
  return name.startsWith('/') ? name : undefined
}

function firstCwd(blob: string): string | undefined {
  for (const line of blob.split('\n')) {
    if (!line.includes('"cwd":')) continue
    try {
      const value = JSON.parse(line).cwd
      if (typeof value === 'string' && value) return value
    } catch {
      // Partial line at the end of the head window.
    }
  }
  return undefined
}

/**
 * Extract the display metadata from a transcript. Results are cached on
 * (size, mtime) because the largest transcript here is ~10MB and most scans
 * touch nothing.
 */
export async function readTranscriptMeta(
  path: string,
  opts: { wantCwd?: boolean } = {},
): Promise<TranscriptMeta | null> {
  let size: number
  let mtimeMs: number
  try {
    const st = await stat(path)
    size = st.size
    mtimeMs = st.mtimeMs
  } catch {
    return null
  }

  const hit = cache.get(path)
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs && (!opts.wantCwd || hit.cwd)) return hit

  const meta: TranscriptMeta = { path, size, mtimeMs }

  const tail = await readSlice(path, size - TAIL_BYTES, Math.min(size, TAIL_BYTES))
  meta.customTitle = lastRecord(tail, 'custom-title', 'customTitle')
  meta.aiTitle = lastRecord(tail, 'ai-title', 'aiTitle')
  meta.lastPrompt = lastRecord(tail, 'last-prompt', 'lastPrompt')
  meta.lastMessageAt = lastMessageAt(tail)

  // Both title records are rewritten as a session runs, so the tail almost
  // always holds them - measured here, the last custom-title sits within 40KB
  // of the end of even a 3.7MB transcript. Only when neither turns up is the
  // whole file worth reading, and then only once per (size, mtime).
  if (!meta.aiTitle && !meta.customTitle && size > TAIL_BYTES && size <= MAX_FULL_SCAN) {
    const whole = await readSlice(path, 0, size)
    meta.customTitle = lastRecord(whole, 'custom-title', 'customTitle')
    meta.aiTitle = lastRecord(whole, 'ai-title', 'aiTitle')
    meta.lastPrompt ??= lastRecord(whole, 'last-prompt', 'lastPrompt')
    meta.lastMessageAt ??= lastMessageAt(whole)
    if (opts.wantCwd) meta.cwd = firstCwd(whole)
    meta.entrypoint = firstField(whole, 'entrypoint')
    meta.command = firstCommand(whole)
  } else {
    // The opening records carry the entrypoint and the launching command, so
    // this window is read whether or not the caller wanted the cwd.
    const head = await readSlice(path, 0, Math.min(size, HEAD_BYTES))
    meta.entrypoint = firstField(head, 'entrypoint')
    meta.command = firstCommand(head)
    if (opts.wantCwd) meta.cwd = firstCwd(head)
  }

  cache.set(path, meta)
  return meta
}

/** Drop cache entries for transcripts that no longer exist. */
export function pruneTranscriptCache(live: Set<string>): void {
  for (const path of cache.keys()) if (!live.has(path)) cache.delete(path)
}
