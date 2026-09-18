import { readFile } from 'node:fs/promises'

/** Read and parse a JSON file, returning null on any failure. */
export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/**
 * Normalise a timestamp to epoch ms. The CLI is inconsistent: `sessions/*.json`
 * and `agents --json` use epoch ms, `jobs/<id>/state.json` uses ISO-8601, and
 * `history.jsonl` uses epoch ms as a *string*.
 */
export function toMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value)
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

/** Quote a string for safe use as a single POSIX shell word. */
export function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}

/** Pull `2.1.246` out of `claude --version`'s "2.1.246 (Claude Code)". */
export function parseVersion(raw: string): string {
  return /(\d+\.\d+\.\d+)/.exec(raw)?.[1] ?? ''
}

/** Compare dotted numeric versions: negative if `a` is older than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}
