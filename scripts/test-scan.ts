// A whole scan, end to end, against a throwaway HOME: a fake `claude` binary
// lists stand-in processes, and the board has to work out from `ps`, the
// transcripts and its own hook records what each card says. This is where the
// per-session fields added on top of discovery - hook status, suspended,
// resumable, context - meet, so it pins how they combine rather than each
// piece alone.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home directory once, at import, so this must come first.
const home = mkdtempSync(join(tmpdir(), 'board-scan-'))
process.env.HOME = home
const { scan } = await import('../src/core/scanner.ts')
const { slugifyCwd } = await import('../src/core/registry.ts')

const bin = join(home, 'bin')
mkdirSync(bin)
const claude = join(bin, 'claude')
writeFileSync(
  claude,
  `#!/bin/sh
case "$1" in
  --version) echo "2.1.999 (Claude Code)" ;;
  agents) cat "$HOME/agents.json" ;;
esac
`,
)
chmodSync(claude, 0o755)

/**
 * Something `ps` reports as a claude process. Detached, so it has no
 * controlling terminal however the test is run - the tty is what `where` and
 * the title come from, and this test is not about those.
 */
const children: ChildProcess[] = []
function standIn(): number {
  const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], {
    argv0: claude,
    detached: true,
    stdio: 'ignore',
  })
  children.push(child)
  return child.pid!
}

const sid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
const project = join(home, '.claude/projects/-tmp-demo')
mkdirSync(project, { recursive: true })
const transcript = (id: string, contextTokens: number) =>
  writeFileSync(
    join(project, `${id}.jsonl`),
    [
      { type: 'user', message: { content: 'hi' }, timestamp: new Date().toISOString() },
      {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          model: 'claude-opus-5-5',
          usage: { input_tokens: 10, cache_read_input_tokens: contextTokens - 10 },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  )
const hooks = join(home, '.claude-board/hooks')
mkdirSync(hooks, { recursive: true })
const hook = (id: string, event: string) =>
  writeFileSync(join(hooks, `${id}.json`), JSON.stringify({ event, kind: '', at: Date.now() }))

try {
  const prompted = standIn() // has a transcript, and the hook says it is mid-turn
  const fresh = standIn() // never got a prompt: no transcript
  const parked = standIn() // Ctrl+Z
  const job = standIn() // a background job
  process.kill(parked, 'SIGSTOP')

  transcript(sid(1), 100_000)
  hook(sid(1), 'UserPromptSubmit')
  transcript(sid(5), 30_000) // finished: a transcript with no process
  hook(sid(4), 'UserPromptSubmit')

  const entry = (pid: number, n: number, extra: object = {}) => ({
    pid,
    sessionId: sid(n),
    cwd: '/tmp/demo',
    kind: 'interactive',
    name: `session ${n}`,
    status: 'idle',
    ...extra,
  })
  writeFileSync(
    join(home, 'agents.json'),
    JSON.stringify([
      entry(prompted, 1),
      entry(fresh, 2, { status: 'waiting', waitingFor: 'input' }),
      entry(parked, 3),
      entry(job, 4, { kind: 'background', id: 'abcd1234', state: 'done' }),
    ]),
  )
  await new Promise((r) => setTimeout(r, 200))

  const result = await scan({ claudeBin: claude, finishedLimit: 0 })
  assert.equal(result.error, undefined)
  const card = (n: number) => {
    const s = result.sessions.find((x) => x.sessionId === sid(n))
    assert.ok(s, `session ${n} is on the board`)
    return s
  }

  // The board's own hook outranks the status Claude reported.
  assert.equal(card(1).status, 'busy')
  assert.equal(card(1).live, true)
  assert.equal(card(1).suspended, false)
  assert.equal(card(1).resumable, true)
  assert.equal(card(1).contextTokens, 100_000)
  assert.equal(card(1).contextPercent, 50)

  // No hook record: Claude's own status stands. No transcript: nothing to
  // resume, and no context to measure.
  assert.equal(card(2).status, 'waiting')
  assert.equal(card(2).waitingFor, 'input')
  assert.equal(card(2).resumable, false)
  assert.equal(card(2).contextPercent, undefined)

  // Stopped with Ctrl+Z: still live, and flagged.
  assert.equal(card(3).live, true)
  assert.equal(card(3).suspended, true)

  // A background job keeps its job state; a turn ending says less than that.
  assert.equal(card(4).status, 'done')
  assert.equal(card(4).kind, 'background')

  // Nothing running behind it: exited, and resumable from its transcript.
  assert.equal(card(5).status, 'exited')
  assert.equal(card(5).live, false)
  assert.equal(card(5).suspended, false)
  assert.equal(card(5).resumable, true)
  assert.equal(card(5).contextPercent, 15)

  // The context window is configurable.
  const wider = await scan({ claudeBin: claude, finishedLimit: 0, contextWindow: 400_000 })
  assert.equal(wider.sessions.find((x) => x.sessionId === sid(1))?.contextPercent, 25)

  /*
   * Claude 2.1.28x to 2.1.327: `claude agents` lists no interactive session
   * and nothing on disk names the one a pid is running - only a `.key` file
   * says it is there. Each project here has a session from yesterday that
   * filled its window and used subagents, so it has a session directory.
   * A live card must never take that session's title and its 99%.
   */
  writeFileSync(join(home, 'agents.json'), '[]')
  const loop = join(home, 'loop.sh')
  writeFileSync(loop, 'while :; do sleep 1; done\n')
  const yesterday = (Date.now() - 86_400_000) / 1000
  const uid = (c: string) => `${c.repeat(8)}-0000-4000-8000-000000000000`
  const projectOf = (cwd: string) => join(home, '.claude/projects', slugifyCwd(cwd))
  const written = (cwd: string, id: string, tokens: number, at?: number) => {
    mkdirSync(projectOf(cwd), { recursive: true })
    const path = join(projectOf(cwd), `${id}.jsonl`)
    const reply = { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10 } }
    writeFileSync(path, `${JSON.stringify({ type: 'assistant', message: reply })}\n`)
    if (at) utimesSync(path, at, at)
  }
  const filledYesterday = (cwd: string, id: string) => {
    written(cwd, id, 198_000, yesterday)
    mkdirSync(join(projectOf(cwd), id, 'subagents'), { recursive: true })
    utimesSync(join(projectOf(cwd), id), yesterday, yesterday)
  }
  /** A claude in `cwd`, run as a script file: `sh -c` would read as `-c`, --continue. */
  const liveIn = (name: string, ...args: string[]) => {
    mkdirSync(join(home, name))
    // lsof reports the real path: /private/var/..., not /var/...
    const cwd = realpathSync(join(home, name))
    const child = spawn('/bin/sh', [loop, ...args], { argv0: claude, cwd, detached: true, stdio: 'ignore' })
    children.push(child)
    mkdirSync(join(home, '.claude/sessions'), { recursive: true })
    writeFileSync(join(home, '.claude/sessions', `${child.pid}.0123abcd.key`), '')
    return { cwd, pid: child.pid! }
  }

  // Today's session has written, but not used a subagent yet.
  const busy = liveIn('busy')
  filledYesterday(busy.cwd, uid('a'))
  written(busy.cwd, uid('b'), 24_000)
  // Today's session has written nothing at all yet.
  const fresh2 = liveIn('fresh')
  filledYesterday(fresh2.cwd, uid('c'))
  // `--continue` carries on exactly yesterday's session.
  const resumed = liveIn('continued', '--continue')
  filledYesterday(resumed.cwd, uid('d'))
  await new Promise((r) => setTimeout(r, 300))

  const old = await scan({ claudeBin: claude, finishedLimit: 0 })
  const onPid = (pid: number) => old.sessions.find((s) => s.pid === pid && s.live)
  assert.equal(onPid(busy.pid)?.sessionId, uid('b'), 'the session written since it started')
  assert.equal(onPid(busy.pid)?.contextPercent, 12)
  assert.equal(onPid(fresh2.pid)?.sessionId, '', 'unnamed, not yesterday')
  assert.equal(onPid(fresh2.pid)?.contextPercent, undefined)
  assert.equal(onPid(resumed.pid)?.sessionId, uid('d'))
  for (const id of [uid('a'), uid('c')]) {
    assert.equal(old.sessions.find((s) => s.sessionId === id)?.live, false, `${id} is yesterday's`)
  }
} finally {
  for (const c of children) c.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
}

console.log('ok')
