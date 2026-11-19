// The ctx % on each card: which transcript record it is read from, and how it
// is turned into a share of the window.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscriptMeta } from '../src/core/transcripts.ts'
import { contextUsage } from '../src/core/scanner.ts'

const dir = mkdtempSync(join(tmpdir(), 'board-ctx-'))
let n = 0
/** A transcript made of these records, one JSON object per line. */
async function contextOf(...records: unknown[]): Promise<number | undefined> {
  const path = join(dir, `${n++}.jsonl`)
  writeFileSync(path, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n'))
  return (await readTranscriptMeta(path))?.contextTokens
}
const usage = (input: number, created: number, read: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: 999, // what the model wrote, not what it was sent: never counted
})
const reply = (u: object, extra: object = {}) => ({
  type: 'assistant',
  message: { model: 'claude-opus-5-5', usage: u },
  ...extra,
})
const user = { type: 'user', message: { content: 'hi' } }

try {
  // Input, cache writes and cache reads together are what the model was sent.
  assert.equal(await contextOf(user, reply(usage(10, 2_000, 40_000))), 42_010)

  // The last main-thread reply wins over earlier ones.
  assert.equal(await contextOf(reply(usage(1, 0, 1_000)), user, reply(usage(5, 0, 9_000))), 9_005)

  // A subagent's turn runs in its own context, so it must not skew the number.
  assert.equal(
    await contextOf(reply(usage(5, 0, 9_000)), reply(usage(1, 0, 150_000), { isSidechain: true })),
    9_005,
  )

  // `<synthetic>` placeholders carry no real usage.
  const synthetic = { type: 'assistant', message: { model: '<synthetic>', usage: usage(0, 0, 0) } }
  assert.equal(await contextOf(reply(usage(5, 0, 9_000)), synthetic), 9_005)

  // A record that does not parse (the cut-off first line of the tail window)
  // is skipped, not fatal.
  assert.equal(await contextOf(reply(usage(5, 0, 9_000)), '{"type":"assistant","message":{"usa'), 9_005)

  // Nothing to measure yet.
  assert.equal(await contextOf(user), undefined)
  assert.equal(await contextOf(reply(usage(0, 0, 0))), undefined)
} finally {
  rmSync(dir, { recursive: true })
}

// Percent of the configured window.
assert.deepEqual(contextUsage(50_000, 200_000), { contextTokens: 50_000, contextPercent: 25 })
assert.deepEqual(contextUsage(160_000, 200_000), { contextTokens: 160_000, contextPercent: 80 })
// Past the configured window it cannot be on it, so it is on the 1M one -
// 25%, not 125%.
assert.deepEqual(contextUsage(250_000, 200_000), { contextTokens: 250_000, contextPercent: 25 })
// A window configured above 1M is kept, and the percent never passes 100.
assert.equal(contextUsage(1_500_000, 2_000_000).contextPercent, 75)
assert.equal(contextUsage(2_500_000, 2_000_000).contextPercent, 100)
// Unknown, or a nonsense window: no chip rather than a wrong one.
assert.deepEqual(contextUsage(undefined, 200_000), {})
assert.deepEqual(contextUsage(0, 200_000), {})
assert.deepEqual(contextUsage(50_000, 0), {})

console.log('ok')
