// The remote board end to end, without a remote: a stand-in `ssh` runs the
// "remote" side locally, against a throwaway HOME, so the real bootstrap, the
// real upload and the real bundled scanner are what get exercised.
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRemote } from './build-remote.mjs'
import {
  RemoteError,
  RemoteHost,
  explainSshFailure,
  isValidHost,
  tagRemote,
} from '../src/core/remote.ts'
import { installNode, nodePlatform, type NodeRelease } from '../src/core/remoteNode.ts'
import {
  parseLsofPorts,
  pickTerminal,
  sshClientsFor,
  sshDestination,
  sshTarget,
} from '../src/core/sshTerminal.ts'
import { buildRemoteResumeCommand } from '../src/core/commands.ts'
import { splitHost } from '../src/core/hostname.ts'
import type { ProcInfo } from '../src/core/ps.ts'
import type { BoardSession } from '../src/core/types.ts'

// --- Hosts: a name, optionally with a user - never something ssh would
// parse as more.
for (const ok of ['devbox', 'build-01.example.com', '10.0.0.5', 'my_host', 'me@devbox', 'tetractius@zt-tdts3.filtri.io', 'a.b@devbox']) {
  assert.equal(isValidHost(ok), true, ok)
}
for (const bad of ['', 'devbox:2222', '-oProxyCommand=sh', 'a b', 'devbox;rm', '.hidden', '@devbox', 'me@', 'me@@devbox', 'me@-oFoo', '-me@devbox', "me'@devbox", 'me@devbox:22']) {
  assert.equal(isValidHost(bad), false, bad)
}

assert.deepEqual(splitHost('tetractius@zt-tdts3.filtri.io'), { user: 'tetractius', host: 'zt-tdts3.filtri.io' })
assert.deepEqual(splitHost('devbox'), { user: null, host: 'devbox' })

// --- Which host a local `ssh` command line is connected to.
assert.equal(sshDestination('ssh devbox'), 'devbox')
assert.equal(sshDestination('/usr/bin/ssh -p 2222 me@devbox'), 'devbox')
assert.equal(sshDestination('ssh -tA devbox claude'), 'devbox')
assert.equal(sshDestination('ssh -i /k/id -o ServerAliveInterval=5 devbox'), 'devbox')
assert.equal(sshDestination('ssh -oPort=2 devbox'), 'devbox')
assert.equal(sshDestination('ssh ssh://me@devbox:2222'), 'devbox')
assert.equal(sshDestination('ssh -- devbox'), 'devbox')
assert.equal(sshDestination('ssh -J jump devbox'), 'devbox')
assert.equal(sshDestination('ssh -V'), null)
assert.deepEqual(sshTarget('ssh me@devbox'), { user: 'me', host: 'devbox' })
assert.deepEqual(sshTarget('ssh -l me devbox'), { user: 'me', host: 'devbox' })
assert.deepEqual(sshTarget('ssh -lme devbox'), { user: 'me', host: 'devbox' })
assert.deepEqual(sshTarget('ssh -p 22 devbox'), { user: null, host: 'devbox' })

// --- Matching a remote session to a local terminal tab.
const procs = new Map<number, ProcInfo>(
  [
    { pid: 10, tty: 'ttys001', args: 'ssh devbox' },
    { pid: 11, tty: 'ttys002', args: 'ssh -t devbox' },
    { pid: 12, tty: '??', args: 'ssh -T devbox sh -s' }, // the board's own connection
    { pid: 13, tty: 'ttys003', args: 'ssh otherbox' },
    { pid: 14, tty: 'ttys004', args: 'vim ssh devbox' },
  ].map((p) => [p.pid, { ppid: 1, stat: 'S+', comm: p.args.split(' ')[0], ...p }]),
)
const clients = sshClientsFor('devbox', procs)
assert.deepEqual(
  clients.map((c) => [c.pid, c.tty]),
  [
    [10, 'ttys001'],
    [11, 'ttys002'],
    [12, null],
  ],
)
const ports = parseLsofPorts('p10\nf3\nn192.168.1.2:50111->10.0.0.5:22\np11\nf3\nn[::1]:50222->[::1]:22\n')
assert.deepEqual([...ports], [
  [10, [50111]],
  [11, [50222]],
])
// The exact match wins, even with several tabs on the same host.
assert.equal(pickTerminal(clients, ports, 50222), 'ttys002')
// No port, or one that matches nothing (multiplexed, jump host): only a
// single tab on that host is a safe guess.
assert.equal(pickTerminal(clients, ports, undefined), null)
assert.equal(pickTerminal(clients, ports, 59999), null)
assert.equal(pickTerminal(sshClientsFor('otherbox', procs), new Map(), undefined), 'ttys003')
assert.equal(pickTerminal(sshClientsFor('nowhere', procs), new Map(), 50111), null)
// A configured user rules out tabs logged in as someone else, but not tabs
// that do not say (ssh_config may supply the same user).
const users = new Map<number, ProcInfo>(
  [
    { pid: 20, tty: 'ttys010', args: 'ssh me@devbox' },
    { pid: 21, tty: 'ttys011', args: 'ssh other@devbox' },
    { pid: 22, tty: 'ttys012', args: 'ssh -l other devbox' },
    { pid: 23, tty: 'ttys013', args: 'ssh devbox' },
  ].map((p) => [p.pid, { ppid: 1, stat: 'S+', comm: 'ssh', ...p }]),
)
assert.deepEqual(sshClientsFor('me@devbox', users).map((c) => c.pid), [20, 23])
assert.deepEqual(sshClientsFor('devbox', users).map((c) => c.pid), [20, 21, 22, 23])

// --- Which official Node build a host gets, from what it says it is.
const probe = (os: string, arch: string, libc = '') => nodePlatform({ os, arch, libc, fetch: 'curl', sum: 'sha256sum' })
assert.deepEqual(probe('Linux', 'x86_64', 'glibc 2.39'), { platform: 'linux-x64' })
assert.deepEqual(probe('Linux', 'amd64', 'glibc 2.28'), { platform: 'linux-x64' })
assert.deepEqual(probe('Linux', 'aarch64', 'glibc 2.31'), { platform: 'linux-arm64' })
assert.deepEqual(probe('Linux', 'x86_64', 'glibc '), { platform: 'linux-x64' }, 'unknown glibc: the trial run decides')
assert.deepEqual(probe('Darwin', 'arm64'), { platform: 'darwin-arm64' })
assert.deepEqual(probe('Darwin', 'x86_64'), { platform: 'darwin-x64' })
assert.match((probe('Linux', 'x86_64', 'glibc 2.17') as { unsupported: string }).unsupported, /glibc 2\.17.*2\.28/)
assert.match((probe('Linux', 'x86_64', 'musl') as { unsupported: string }).unsupported, /musl/)
assert.match((probe('Linux', 'armv7l', 'glibc 2.36') as { unsupported: string }).unsupported, /armv7l/)
assert.match((probe('MINGW64_NT-10.0', 'x86_64') as { unsupported: string }).unsupported, /Linux and macOS/)
assert.match((probe('FreeBSD', 'amd64') as { unsupported: string }).unsupported, /FreeBSD/)

// --- What ssh's failures turn into.
assert.match(explainSshFailure('devbox', 'me@devbox: Permission denied (publickey).', 255), /ssh-copy-id devbox/)
assert.match(explainSshFailure('devbox', 'Host key verification failed.', 255), /ssh devbox` once/)
assert.match(explainSshFailure('devbox', 'ssh: Could not resolve hostname devbox: nodename nor servname', 255), /unknown host name/)
assert.equal(explainSshFailure('devbox', '', 1), 'devbox: ssh exited with code 1')
assert.match(
  explainSshFailure('winbox', "'sh' is not recognized as an internal or external command,", 1),
  /Windows host/,
)

// --- The resume command survives two rounds of shell parsing: the local
// shell runs ssh, and the remote login shell runs what ssh hands it.
const work = mkdtempSync(join(tmpdir(), 'board-remote-'))
try {
  const odd = join(work, "it's a dir")
  mkdirSync(odd)
  const bin = join(work, 'bin')
  mkdirSync(bin)
  // `ssh -t devbox <cmd>` becomes `sh -c <cmd>`, run here.
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nshift 2\nexec /bin/sh -c "$1"\n')
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nprintf "%s|%s" "$PWD" "$*"\n')
  chmodSync(join(bin, 'ssh'), 0o755)
  chmodSync(join(bin, 'claude'), 0o755)
  const s = { cwd: odd, resumeSessionId: '1234-abcd' } as BoardSession
  assert.match(buildRemoteResumeCommand(s, 'me@devbox'), /^ssh -t me@devbox '/)
  assert.throws(() => buildRemoteResumeCommand(s, 'devbox; rm -rf ~'), /Not a host name/)
  const cmd = buildRemoteResumeCommand(s, 'devbox', join(bin, 'claude'))
  assert.match(cmd, /^ssh -t devbox '/)
  const out = execFileSync('/bin/sh', ['-c', cmd], {
    env: { PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8',
  })
  assert.equal(out, `${odd}|--resume 1234-abcd`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

// --- A whole connection: bootstrap, upload, scan, stop, reconnect.
const home = mkdtempSync(join(tmpdir(), 'board-remote-home-'))
process.env.HOME = home
const children: ChildProcess[] = []
const remoteDir = join(home, '.claude-board/remote')
try {
  const bundle = join(home, 'bundle.mjs')
  await buildRemote(bundle)
  const script = readFileSync(bundle)
  const hash = createHash('sha256').update(script).digest('hex').slice(0, 12)

  const bin = join(home, 'bin')
  mkdirSync(bin)
  // Where the native installer puts it, and the first place the remote
  // scanner looks - nothing tells it which binary to use.
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  const claude = join(home, '.local/bin/claude')
  writeFileSync(
    claude,
    '#!/bin/sh\ncase "$1" in\n  --version) echo "2.1.999 (Claude Code)" ;;\n  agents) cat "$HOME/agents.json" ;;\nesac\n',
  )
  chmodSync(claude, 0o755)

  // Logs what it was asked, then does what ssh would: hand the command to the
  // remote login shell - after that shell has said something of its own.
  const fakeSsh = join(bin, 'fake-ssh')
  writeFileSync(
    fakeSsh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/ssh.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -o) shift 2 ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
echo "Welcome to devbox. Last login: yesterday"
exec /bin/sh -c "$*"
`,
  )
  chmodSync(fakeSsh, 0o755)

  const standIn = () => {
    const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], {
      argv0: claude,
      detached: true,
      stdio: 'ignore',
    })
    children.push(child)
    return child.pid!
  }
  const running = standIn()
  const doomed = standIn()
  const sid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
  writeFileSync(
    join(home, 'agents.json'),
    JSON.stringify(
      [running, doomed].map((pid, i) => ({
        pid,
        sessionId: sid(i + 1),
        cwd: '/tmp',
        kind: 'interactive',
        name: `session ${i + 1}`,
        status: 'idle',
      })),
    ),
  )

  // A scanner left over from an older board, which the upload replaces.
  mkdirSync(remoteDir, { recursive: true })
  writeFileSync(join(remoteDir, 'board-remote-000000000000.mjs'), '// old')

  // What a remote login would have: its own PATH, not this machine's - which
  // would find the real claude here before the stand-in.
  process.env.PATH = [join(home, '.local/bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':')

  const remote = new RemoteHost('devbox', { script, sshBin: fakeSsh })
  const hello = await remote.connect()
  assert.equal(hello.protocol, 1)
  assert.equal(hello.node, process.version)

  // Uploaded once, byte for byte, and the stale version cleared away.
  const uploaded = join(remoteDir, `board-remote-${hash}.mjs`)
  assert.deepEqual(readFileSync(uploaded), script)
  assert.deepEqual(readdirSync(remoteDir), [`board-remote-${hash}.mjs`])
  // Key-only and never interactive: a host without key access must fail, not prompt.
  assert.match(readFileSync(join(home, 'ssh.log'), 'utf8'), /-T -o BatchMode=yes .* -- devbox sh -s/)

  await new Promise((r) => setTimeout(r, 200))
  const raw = await remote.scan({ finishedLimit: 0 })
  assert.equal(raw.error, undefined)
  const result = tagRemote(raw, 'devbox')
  assert.equal(result.host, 'devbox')
  const ids = result.sessions.map((s) => s.sessionId).sort()
  assert.deepEqual(ids, [sid(1), sid(2)])
  for (const s of result.sessions) {
    assert.equal(s.host, 'devbox')
    assert.ok(s.key.startsWith('devbox/'), s.key)
    assert.equal(s.live, true)
  }

  // Stop runs over there, with the same identity check as a local stop.
  await assert.rejects(remote.stop(doomed, 'ttys-elsewhere'), /no longer this session/)
  assert.equal(await remote.stop(doomed, null), true)
  await assert.rejects(remote.request('nope'), /devbox: unknown request: nope/)

  // A dropped connection fails what was in flight, and the next request
  // reconnects - without uploading again.
  const before = statSync(uploaded).mtimeMs
  ;(remote as unknown as { child: ChildProcess }).child.kill()
  await new Promise((r) => setTimeout(r, 200))
  const again = await remote.scan({ finishedLimit: 0 })
  // The stand-in `claude agents` still lists it; its process is what is gone.
  const live = Object.fromEntries(again.sessions.map((s) => [s.sessionId, s.live]))
  assert.deepEqual(live, { [sid(1)]: true, [sid(2)]: false })
  assert.equal(statSync(uploaded).mtimeMs, before)
  assert.equal(readFileSync(join(home, 'ssh.log'), 'utf8').trim().split('\n').length, 2)
  // Hanging up ends the remote scanner: nothing is left running over there.
  const serving = () =>
    execFileSync('ps', ['-Ao', 'args='], { encoding: 'utf8' }).includes(uploaded)
  assert.equal(serving(), true)
  remote.close()
  for (let i = 0; i < 20 && serving(); i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(serving(), false)

  // ssh refusing the key comes back as what to do about it.
  const refusing = join(bin, 'refusing-ssh')
  writeFileSync(refusing, '#!/bin/sh\necho "me@devbox: Permission denied (publickey)." >&2\nexit 255\n')
  chmodSync(refusing, 0o755)
  await assert.rejects(
    new RemoteHost('devbox', { script, sshBin: refusing }).scan({}),
    /ssh-copy-id devbox/,
  )

  assert.throws(() => new RemoteHost('-oProxyCommand=sh', { script }), /Not a host name/)
  assert.equal(existsSync(uploaded), true)
} finally {
  for (const c of children) c.kill('SIGKILL')
  rmSync(home, { recursive: true, force: true })
}

// --- A host with no Node: the board installs its own, and connects with it.
const bare = mkdtempSync(join(tmpdir(), 'board-remote-bare-'))
const realNode = process.execPath
process.env.HOME = bare
try {
  const bin = join(bare, 'bin')
  mkdirSync(bin)
  // No Node anywhere a login could find one: a stripped PATH, a login shell
  // that prints nothing, and no fixed places to look.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  const quiet = join(bin, 'quiet-shell')
  writeFileSync(quiet, '#!/bin/sh\nexit 0\n')
  chmodSync(quiet, 0o755)
  process.env.SHELL = quiet
  const ssh = join(bin, 'fake-ssh')
  writeFileSync(
    ssh,
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --) shift; break ;; -o) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec /bin/sh -c "$*"\n',
  )
  chmodSync(ssh, 0o755)
  mkdirSync(join(bare, '.local/bin'), { recursive: true })
  writeFileSync(join(bare, '.local/bin/claude'), '#!/bin/sh\ncase "$1" in --version) echo "2.1.999 (Claude Code)" ;; agents) echo "[]" ;; esac\n')
  chmodSync(join(bare, '.local/bin/claude'), 0o755)

  const scanner = readFileSync(await buildRemote(join(bare, 'bundle.mjs')))
  const host = new RemoteHost('me@devbox', { script: scanner, sshBin: ssh, nodePaths: [] })
  await assert.rejects(host.connect(), (err: Error) => {
    assert.ok(err instanceof RemoteError)
    assert.equal(err.reason, 'no-node')
    assert.match(err.message, /no Node\.js 18 or newer/)
    return true
  })

  // A stand-in nodejs.org: a release for this very machine, whose `node`
  // hands over to the real one - so the trial run and the scanner both work.
  const platform = `${process.platform}-${process.arch}` as 'darwin-arm64'
  const release = (sha: string, baseUrl: string): NodeRelease => ({
    version: process.version,
    baseUrl,
    sha256: { [platform]: sha } as NodeRelease['sha256'],
  })
  const dist = join(bare, 'dist')
  const pack = (label: string, nodeScript: string) => {
    const root = join(bare, `pack-${label}`)
    const name = `node-${process.version}-${platform}`
    mkdirSync(join(root, name, 'bin'), { recursive: true })
    writeFileSync(join(root, name, 'bin/node'), nodeScript)
    chmodSync(join(root, name, 'bin/node'), 0o755)
    writeFileSync(join(root, name, 'README.md'), 'not extracted: only bin/node is')
    const out = join(dist, label, process.version)
    mkdirSync(out, { recursive: true })
    const file = join(out, `${name}.tar.gz`)
    execFileSync('tar', ['-czf', file, '-C', root, name])
    const bytes = readFileSync(file)
    return { file, bytes, sha: createHash('sha256').update(bytes).digest('hex'), url: `file://${join(dist, label)}` }
  }
  const good = pack('good', `#!/bin/sh\nexec '${realNode}' "$@"\n`)
  const broken = pack('broken', '#!/bin/sh\necho "cannot execute binary file: Exec format error"\n')
  const own = join(bare, '.claude-board/remote/node/bin/node')
  const local = (bytes: Buffer) => async () => bytes

  // The host downloads it itself, checks it, runs it, and only then installs it.
  const installed = await installNode('me@devbox', { sshBin: ssh, release: release(good.sha, good.url) })
  assert.match(installed, /downloaded there/)
  assert.equal(execFileSync(own, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8' }), process.version)
  assert.deepEqual(readdirSync(join(bare, '.claude-board/remote')), ['node'], 'no scratch left behind')
  assert.deepEqual(readdirSync(join(bare, '.claude-board/remote/node')), ['bin'], 'only the binary is unpacked')

  // ...and the scanner now starts with it: nothing on PATH, nothing else changed.
  const hello = await host.connect()
  assert.equal(hello.node, process.version)
  host.close()

  // A build that does not run there is refused, and the working one stays.
  await assert.rejects(
    installNode('me@devbox', { sshBin: ssh, release: release(broken.sha, broken.url) }),
    /does not run there.*Exec format error.*Nothing was changed/,
  )
  assert.equal(existsSync(own), true)
  assert.equal(execFileSync(own, ['-e', 'process.stdout.write("still here")'], { encoding: 'utf8' }), 'still here')

  // No route from the host: fetched here instead, checked, and uploaded.
  rmSync(join(bare, '.claude-board/remote/node'), { recursive: true })
  const uploaded = await installNode('me@devbox', {
    sshBin: ssh,
    release: release(good.sha, `file://${join(bare, 'nowhere')}`),
    download: local(good.bytes),
  })
  assert.match(uploaded, /uploaded from this machine/)
  assert.equal(existsSync(own), true)

  // A download that does not match its pinned checksum is never run or kept -
  // neither the host's copy nor the one fetched here.
  rmSync(join(bare, '.claude-board/remote/node'), { recursive: true })
  await assert.rejects(
    installNode('me@devbox', { sshBin: ssh, release: release('0'.repeat(64), good.url), download: local(good.bytes) }),
    /did not match its pinned checksum/,
  )
  assert.equal(existsSync(join(bare, '.claude-board/remote/node')), false)
} finally {
  rmSync(bare, { recursive: true, force: true })
}

console.log('ok')
