// The slug is how a live pid's cwd is matched to its transcript folder. It is
// lossy on purpose - `/` and `_` both collapse to `-` - so it is worth pinning.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { slugifyCwd } from '../src/core/registry.ts'
import { ttyOf } from '../src/core/scanner.ts'
import {
  attentionSummary,
  isDormant,
  newlyFinished,
  newlyNeedingAttention,
  settleFinished,
  snapshot,
} from '../src/core/attention.ts'
import {
  buildProcIndex,
  isForeground,
  isSuspended,
  terminalOf,
  type ProcInfo,
} from '../src/core/ps.ts'
import { stopSession } from '../src/core/stop.ts'
import type { BoardSession, Status } from '../src/core/types.ts'

assert.equal(slugifyCwd('/Users/fil/git/claude-code-board'), '-Users-fil-git-claude-code-board')
// The underscore case: the reason the slug can never be reversed back to a path.
assert.equal(
  slugifyCwd('/Users/fil/git/hive-mono-ENG-591-semantic_docs'),
  '-Users-fil-git-hive-mono-ENG-591-semantic-docs',
)
assert.equal(slugifyCwd('/'), '-')

// `ps` spells "no controlling terminal" differently per platform, and only the
// macOS spelling was handled - on Linux every headless session claimed a
// terminal named `?`.
const claude = (tty: string) =>
  ({ pid: 1, ppid: 0, tty, stat: 'S+', comm: 'claude', args: 'claude' }) as ProcInfo
assert.equal(ttyOf(claude('??')), null, 'macOS: no tty')
assert.equal(ttyOf(claude('?')), null, 'Linux: no tty')
assert.equal(ttyOf(claude('-')), null, 'no tty')
assert.equal(ttyOf(claude('ttys000')), 'ttys000', 'macOS terminal')
assert.equal(ttyOf(claude('pts/0')), 'pts/0', 'Linux terminal')

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

// The notification body: what the session wants, in the fewest words that say it.
const wants = (over: Partial<BoardSession>) =>
  attentionSummary({ status: 'waiting', ...over } as BoardSession)
assert.equal(wants({ needs: 'Approve the migration?' }), 'Approve the migration?')
assert.equal(wants({ waitingFor: 'permission' }), 'Needs your permission')
assert.equal(wants({ waitingFor: 'input' }), 'Waiting for input')
assert.equal(wants({}), 'Waiting for you')
assert.equal(wants({ status: 'blocked' }), 'Blocked')

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

// Dormant: live and untouched past the threshold, or suspended at any age.
const now = Date.now()
const session = (over: Partial<BoardSession>) =>
  ({ live: true, status: 'idle', suspended: false, lastActivity: now, ...over }) as BoardSession
assert.equal(isDormant(session({ lastActivity: now - 25 * 3_600_000 }), 24, now), true)
assert.equal(isDormant(session({ lastActivity: now - 1 * 3_600_000 }), 24, now), false)
assert.equal(isDormant(session({ suspended: true }), 24, now), true)
assert.equal(isDormant(session({ status: 'waiting', lastActivity: 0 }), 24, now), false)
assert.equal(isDormant(session({ live: false, status: 'exited', lastActivity: 0 }), 24, now), false)

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

// stopSession's identity guard uses terminalOf, so it must agree with ttyOf
// on both spellings of "no terminal" - otherwise a headless Linux session
// is refused as having moved to a terminal named `?`.
const tty = (t: string) => ({ tty: t }) as ProcInfo
assert.equal(terminalOf(tty('??')), null, 'macOS: no tty')
assert.equal(terminalOf(tty('?')), null, 'Linux: no tty')
assert.equal(terminalOf(tty('-')), null)
assert.equal(terminalOf(tty('pts/3')), 'pts/3')
assert.equal(terminalOf(undefined), null)

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
// The stand-ins inherit this process's controlling terminal, if it has one:
// none under CI or an agent, a real one when run by hand from a shell.
const here = terminalOf((await buildProcIndex()).get(process.pid))
try {
  await assert.rejects(stopSession(other.pid!, null), /no longer this session/)
  assert.equal(alive(other.pid!), true)
  await assert.rejects(stopSession(fake.pid!, 'ttys-elsewhere'), /no longer this session/)
  assert.equal(alive(fake.pid!), true)
  assert.equal(await stopSession(fake.pid!, here), true)
  assert.equal(await stopSession(paused.pid!, here, 2000), true)
} finally {
  other.kill()
  fake.kill()
  paused.kill('SIGKILL')
  rmSync(dir, { recursive: true })
}

console.log('ok')
