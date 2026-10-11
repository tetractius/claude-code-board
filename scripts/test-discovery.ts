// The slug is how a live pid's cwd is matched to its transcript folder. It is
// lossy on purpose - `/` and `_` both collapse to `-` - so it is worth pinning.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugifyCwd } from '../src/core/registry.ts'
import { newlyNeedingAttention, snapshot } from '../src/core/attention.ts'
import { isForeground, isSuspended, type ProcInfo } from '../src/core/ps.ts'
import { stopSession } from '../src/core/stop.ts'
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

// `ps` state: T is stopped (Ctrl+Z); S/R with any modifiers is not.
const proc = (stat: string) => ({ stat }) as ProcInfo
assert.equal(isSuspended(proc('T')), true)
assert.equal(isSuspended(proc('T+')), true)
assert.equal(isSuspended(proc('S+')), false)
assert.equal(isSuspended(proc('Ss')), false)
assert.equal(isSuspended(undefined), false)
// `+` marks the process on screen in its tab; a stopped one behind it lacks it.
assert.equal(isForeground(proc('S+')), true)
assert.equal(isForeground(proc('T')), false)
assert.equal(isForeground(undefined), false)

// Stop only ever signals the session it was asked about. A pid that is not
// Claude, or Claude on a different terminal, is refused and left running.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const dir = mkdtempSync(join(tmpdir(), 'board-stop-'))
symlinkSync('/bin/sleep', join(dir, 'claude'))
const other = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
const fake = spawn(join(dir, 'claude'), ['30'], { stdio: 'ignore' })
// Suspended with Ctrl+Z, real Claude re-suspends itself while handling
// SIGTERM, so it is killed instead. This stand-in does the same.
const paused = spawn('/bin/sh', ['-c', "trap 'kill -STOP $$' TERM; while :; do sleep 1; done"], {
  argv0: join(dir, 'claude'),
  stdio: 'ignore',
})
await new Promise((r) => setTimeout(r, 200))
process.kill(paused.pid!, 'SIGSTOP')
try {
  await assert.rejects(stopSession(other.pid!, null), /no longer this session/)
  assert.equal(alive(other.pid!), true)
  await assert.rejects(stopSession(fake.pid!, 'ttys999'), /no longer this session/)
  assert.equal(alive(fake.pid!), true)
  assert.equal(await stopSession(fake.pid!, null), true)
  assert.equal(await stopSession(paused.pid!, null, 2000), true)
} finally {
  other.kill()
  fake.kill()
  paused.kill('SIGKILL')
  rmSync(dir, { recursive: true })
}

console.log('ok')
