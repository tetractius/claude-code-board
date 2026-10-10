// The slug is how a live pid's cwd is matched to its transcript folder. It is
// lossy on purpose - `/` and `_` both collapse to `-` - so it is worth pinning.
import assert from 'node:assert/strict'
import { slugifyCwd } from '../src/core/registry.ts'
import {
  newlyFinished,
  newlyNeedingAttention,
  settleFinished,
  snapshot,
} from '../src/core/attention.ts'
import { isSuspended, type ProcInfo } from '../src/core/ps.ts'
import type { BoardSession, Status } from '../src/core/types.ts'

assert.equal(slugifyCwd('/Users/fil/git/claude-code-board'), '-Users-fil-git-claude-code-board')
// The underscore case: the reason the slug can never be reversed back to a path.
assert.equal(
  slugifyCwd('/Users/fil/git/hive-mono-ENG-591-semantic_docs'),
  '-Users-fil-git-hive-mono-ENG-591-semantic-docs',
)
assert.equal(slugifyCwd('/'), '-')

// Notifications fire on the transition into waiting/blocked, never at launch
// and never twice for a session that stays blocked.
const card = (key: string, status: Status) => ({ key, status }) as BoardSession
const keys = (xs: BoardSession[]) => xs.map((s) => s.key)
const first = [card('a', 'busy'), card('b', 'waiting')]
assert.deepEqual(newlyNeedingAttention(null, first), [])
const second = [card('a', 'waiting'), card('b', 'waiting'), card('c', 'blocked')]
assert.deepEqual(keys(newlyNeedingAttention(snapshot(first), second)), ['a', 'c'])
assert.deepEqual(newlyNeedingAttention(snapshot(second), second), [])
// waiting -> blocked is still the same need, not a new one.
assert.deepEqual(newlyNeedingAttention(snapshot(second), [card('a', 'blocked')]), [])

// Finished: busy -> idle once; busy -> waiting is a need, not a finish.
const running = [card('a', 'busy'), card('b', 'busy'), card('c', 'working')]
const after = [card('a', 'idle'), card('b', 'waiting'), card('c', 'done')]
assert.deepEqual(keys(newlyFinished(snapshot(running), after)), ['a', 'c'])
assert.deepEqual(newlyFinished(snapshot(after), after), [])
assert.deepEqual(newlyFinished(null, after), [])

// A finish is announced only after 10s of quiet; a blip back to busy cancels it.
const pending = new Map<string, number>()
assert.deepEqual(settleFinished(pending, [card('a', 'idle')], [card('a', 'idle')], 0), [])
assert.deepEqual(settleFinished(pending, [], [card('a', 'busy')], 4_000), [])
assert.deepEqual(settleFinished(pending, [card('a', 'idle')], [card('a', 'idle')], 6_000), [])
assert.deepEqual(keys(settleFinished(pending, [], [card('a', 'idle')], 16_000)), ['a'])
assert.deepEqual(settleFinished(pending, [], [card('a', 'idle')], 30_000), [])

// `ps` state: T is stopped (Ctrl+Z); S/R with any modifiers is not.
const proc = (stat: string) => ({ stat }) as ProcInfo
assert.equal(isSuspended(proc('T')), true)
assert.equal(isSuspended(proc('T+')), true)
assert.equal(isSuspended(proc('S+')), false)
assert.equal(isSuspended(proc('Ss')), false)
assert.equal(isSuspended(undefined), false)

console.log('ok')
