import { open, stat } from 'node:fs/promises'
import { HISTORY_FILE } from './paths.ts'
import { toMs } from './util.ts'

/** Only ever read the tail; this file grows without bound. */
const MAX_BYTES = 4 * 1024 * 1024

/**
 * `~/.claude/history.jsonl` records every prompt you have typed, tagged with
 * its sessionId. Taking the max timestamp per session is by far the cheapest
 * accurate way to answer "when did I last talk to this session?" - the
 * alternative is scanning multi-megabyte transcripts.
 *
 * Note `timestamp` is epoch ms held in a *string*.
 */
export async function buildHistoryIndex(): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  let size: number
  try {
    size = (await stat(HISTORY_FILE)).size
  } catch {
    return index
  }

  let blob: string
  const fh = await open(HISTORY_FILE, 'r')
  try {
    const length = Math.min(size, MAX_BYTES)
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await fh.read(buf, 0, length, size - length)
    blob = buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }

  for (const line of blob.split('\n')) {
    if (!line.includes('"sessionId"')) continue
    try {
      const { sessionId, timestamp } = JSON.parse(line)
      if (typeof sessionId !== 'string') continue
      const ts = toMs(timestamp)
      if (ts > (index.get(sessionId) ?? 0)) index.set(sessionId, ts)
    } catch {
      // The first line of the window is usually truncated.
    }
  }
  return index
}
