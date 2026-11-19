import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import { isValidHost } from './hostname.ts'
import type { ScanResult } from './types.ts'

/**
 * Showing the board for another machine, over SSH.
 *
 * The board does not reimplement its scanner as remote commands: it ships the
 * real one. `src/remote/serve.ts` and the core it imports are bundled into one
 * script, uploaded once to `~/.claude-board/remote/` on the host, and kept
 * running for as long as the host is selected, answering scan requests over
 * the SSH connection's stdin and stdout. The remote needs Node 18+ and nothing
 * else.
 *
 * Only a host, optionally with a user (`me@devbox`), is ever configured.
 * Everything else - port, identity file, jump hosts, multiplexing - is ssh's
 * business, read from `~/.ssh/config` as for any other `ssh`. Connections run
 * with BatchMode, so ssh never stops to ask for a password or a passphrase: a
 * host without key access fails with a message saying so, rather than hanging.
 */

/** What every reply line starts with; anything else on stdout is the remote shell talking. */
export const MARK = '@@board '

export { isValidHost }

const SSH_OPTIONS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
]

export interface RemoteHello {
  protocol: number
  node: string
  platform: string
}

/** Where a host's own Node is looked for, after PATH. */
const NODE_PATHS = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']

export interface RemoteOptions {
  /** The bundled remote scanner, exactly as it will be uploaded. */
  script: Buffer
  /** The ssh executable. Tests substitute a stand-in that runs locally. */
  sshBin?: string
  /** How long to wait for the remote scanner to come up, upload included. */
  connectTimeoutMs?: number
  /** Overrides the fixed places Node is looked for on the host; for tests. */
  nodePaths?: string[]
}

/**
 * A failure with a machine-readable reason, so the caller can tell "this
 * host has no Node, offer to install one" from everything else.
 */
export class RemoteError extends Error {
  readonly reason?: string
  constructor(message: string, reason?: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Run by the remote's `sh -s`. Everything is inside one function, called on
 * the last line, so the shell has read the whole script before running any
 * of it: `head -c` then reads the upload from the same stdin, and the shell
 * cannot have consumed any of it as script, nor the script as upload. The
 * `exit` on that same line means an early return never goes on to read
 * whatever is left on stdin as more script.
 *
 * Node is looked for on PATH, then on a login shell's PATH and an interactive
 * one's (where nvm, fnm and volta usually put it), then in the usual places,
 * and last in `~/.claude-board/remote/node` - the board's own, if it was
 * installed there (see remoteNode.ts). The first that is 18 or newer wins, so
 * a host's own Node is used when it has a good one.
 */
export function bootstrapScript(hash: string, size: number, nodePaths = NODE_PATHS): string {
  const say = (json: string) => `printf '%s\\n' '${MARK}${json}'`
  return `main() {
  d="$HOME/.claude-board/remote"
  f="$d/board-remote-${hash}.mjs"
  node=
  old=
  consider() {
    [ -z "$node" ] && [ -n "$1" ] && [ -x "$1" ] || return 0
    if "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
      node=$1
    else
      old=$("$1" -v 2>/dev/null)
    fi
  }
  consider "$(command -v node 2>/dev/null)"
  consider "$("\${SHELL:-sh}" -lc 'command -v node' </dev/null 2>/dev/null | tail -n 1)"
  consider "$("\${SHELL:-sh}" -ic 'command -v node' </dev/null 2>/dev/null | tail -n 1)"
  for c in ${nodePaths.map((p) => `'${p}'`).join(' ')}; do consider "$c"; done
  consider "$d/node/bin/node"
  if [ -z "$node" ]; then
    if [ -n "$old" ]; then
      printf '%s{"stage":"error","reason":"old-node","node":"%s"}\\n' '${MARK}' "$old"
    else
      ${say('{"stage":"error","reason":"no-node"}')}
    fi
    return
  fi
  if [ ! -f "$f" ]; then
    ${say('{"stage":"upload"}')}
    if mkdir -p "$d" && head -c ${size} > "$f.tmp" && mv "$f.tmp" "$f"; then
      for old in "$d"/board-remote-*.mjs; do [ "$old" = "$f" ] || rm -f "$old"; done
    else
      ${say('{"stage":"error","reason":"upload"}')}
      return
    fi
  fi
  exec "$node" "$f" --serve
}
main; exit
`
}

/** Turn ssh's last words into something that says what to do about them. */
export function explainSshFailure(host: string, stderr: string, code: number | null): string {
  const last = stderr.trim().split('\n').filter(Boolean).pop() ?? ''
  if (/Permission denied/i.test(stderr)) {
    return (
      `${host}: SSH refused the key (permission denied). The board never asks for a ` +
      `password - push your public key with \`ssh-copy-id ${host}\`.`
    )
  }
  if (/Host key verification failed/i.test(stderr)) {
    return `${host}: its host key is not trusted yet. Run \`ssh ${host}\` once in a terminal to accept it.`
  }
  if (/Could not resolve hostname/i.test(stderr)) {
    return `${host}: unknown host name. Check the spelling, or add it to ~/.ssh/config.`
  }
  // cmd.exe or PowerShell answering for `sh`: a Windows host.
  if (/is not recognized as (an internal or external command|the name of a cmdlet)/i.test(stderr)) {
    return `${host}: this looks like a Windows host. The board supports Linux and macOS hosts (WSL counts as Linux).`
  }
  return `${host}: ${last || `ssh exited with code ${code ?? 'unknown'}`}`
}

const INSTALL_HINT = 'Test it in Settings → Remote hosts to install the board’s own copy.'

function explainStage(host: string, stage: { reason?: string; node?: string }): string {
  switch (stage.reason) {
    case 'no-node':
      return `${host}: no Node.js 18 or newer there. ${INSTALL_HINT}`
    case 'old-node':
      return `${host}: its Node ${stage.node || '(unknown version)'} is older than the 18 the board needs. ${INSTALL_HINT}`
    case 'upload':
      return `${host}: could not write the board's scanner to ~/.claude-board/remote.`
    default:
      return `${host}: the remote scanner did not start (${stage.reason ?? 'unknown'}).`
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One remote host's scanner, over one long-lived SSH connection. Connects on
 * the first request, and again on the next request after the connection
 * drops; requests in flight when it drops fail rather than hang.
 */
export class RemoteHost {
  readonly host: string
  hello?: RemoteHello
  private readonly opts: RemoteOptions
  private readonly hash: string
  private child?: ChildProcessWithoutNullStreams
  private connecting?: Promise<RemoteHello>
  private readonly pending = new Map<number, Pending>()
  private nextId = 1

  constructor(host: string, opts: RemoteOptions) {
    if (!isValidHost(host)) throw new Error(`Not a host name: ${JSON.stringify(host)}`)
    this.host = host
    this.opts = opts
    this.hash = createHash('sha256').update(opts.script).digest('hex').slice(0, 12)
  }

  connect(): Promise<RemoteHello> {
    this.connecting ??= this.open().catch((err: Error) => {
      this.connecting = undefined
      this.kill()
      throw err
    })
    return this.connecting
  }

  async request<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    await this.connect()
    const child = this.child
    if (!child) throw new Error(`${this.host}: not connected`)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.host}: no reply to "${op}" after ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      child.stdin.write(JSON.stringify({ id, op, args }) + '\n')
    })
  }

  scan(args: { finishedLimit?: number; contextWindow?: number }): Promise<ScanResult> {
    return this.request<ScanResult>('scan', args)
  }

  stop(pid: number, tty: string | null): Promise<boolean> {
    return this.request<boolean>('stop', { pid, tty }, 30_000)
  }

  /** Hang up. The remote scanner exits when its stdin closes. */
  close(): void {
    const child = this.child
    this.connecting = undefined
    this.child = undefined
    this.failAll(new Error(`${this.host}: disconnected`))
    if (!child) return
    child.stdin.end()
    setTimeout(() => child.kill(), 2000).unref()
  }

  private kill(): void {
    this.child?.kill()
    this.child = undefined
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
      this.pending.delete(id)
    }
  }

  private open(): Promise<RemoteHello> {
    const { script, sshBin = 'ssh', connectTimeoutMs = 45_000 } = this.opts
    const child = spawn(sshBin, [...SSH_OPTIONS, '--', this.host, 'sh', '-s'], { stdio: 'pipe' })
    this.child = child
    // A write after the remote has gone surfaces as an EPIPE here; the exit
    // handler below is what reports it.
    child.stdin.on('error', () => {})

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })

    return new Promise<RemoteHello>((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      }
      const timer = setTimeout(
        () => fail(new Error(`${this.host}: the remote scanner did not start within ${connectTimeoutMs / 1000}s`)),
        connectTimeoutMs,
      )

      let buffered = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffered += chunk.toString()
        let nl: number
        while ((nl = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, nl)
          buffered = buffered.slice(nl + 1)
          if (!line.startsWith(MARK)) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line.slice(MARK.length))
          } catch {
            continue
          }
          if (msg.stage === 'upload') {
            child.stdin.write(script)
          } else if (msg.stage === 'error') {
            fail(new RemoteError(explainStage(this.host, msg), String(msg.reason)))
          } else if (msg.hello) {
            this.hello = msg.hello as RemoteHello
            settled = true
            clearTimeout(timer)
            resolve(this.hello)
          } else if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id)
            if (!p) continue
            this.pending.delete(msg.id)
            clearTimeout(p.timer)
            if (msg.ok) p.resolve(msg.result)
            else p.reject(new Error(`${this.host}: ${String(msg.error)}`))
          }
        }
      })

      child.on('error', (err) => fail(new Error(`${this.host}: could not run ssh: ${err.message}`)))
      child.on('exit', (code) => {
        const err = new Error(explainSshFailure(this.host, stderr, code))
        if (this.child === child) {
          this.child = undefined
          this.connecting = undefined
        }
        this.failAll(err)
        fail(err)
      })

      child.stdin.write(bootstrapScript(this.hash, script.length, this.opts.nodePaths))
    })
  }
}

export interface ScriptOptions {
  sshBin?: string
  timeoutMs?: number
  /** Each reply line as it arrives, with the remote's stdin to answer on. */
  onMessage?: (msg: Record<string, unknown>, stdin: Writable) => void
  /**
   * Leave stdin open after the script, for one that reads more from it (an
   * upload); `onMessage` must then end it. Otherwise it closes at once.
   */
  holdStdin?: boolean
}

/**
 * Run a one-off script on a host with `sh -s` and collect its `@@board`
 * lines. For short jobs - a probe, an install - that do not need the
 * long-lived scanner connection. Throws with ssh's explanation when the host
 * could not be reached or the script never said anything.
 */
export function runScript(
  destination: string,
  script: string,
  opts: ScriptOptions = {},
): Promise<{ messages: Record<string, unknown>[]; stderr: string }> {
  if (!isValidHost(destination)) return Promise.reject(new Error(`Not a host name: ${destination}`))
  const { sshBin = 'ssh', timeoutMs = 60_000, onMessage, holdStdin = false } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(sshBin, [...SSH_OPTIONS, '--', destination, 'sh', '-s'], { stdio: 'pipe' })
    child.stdin.on('error', () => {})
    const messages: Record<string, unknown>[] = []
    let stderr = ''
    let buffered = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${destination}: no answer after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let nl: number
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        if (!line.startsWith(MARK)) continue
        try {
          const msg = JSON.parse(line.slice(MARK.length)) as Record<string, unknown>
          messages.push(msg)
          onMessage?.(msg, child.stdin)
        } catch {
          // not ours
        }
      }
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${destination}: could not run ssh: ${err.message}`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (messages.length === 0) reject(new Error(explainSshFailure(destination, stderr, code)))
      else resolve({ messages, stderr })
    })
    if (holdStdin) child.stdin.write(script)
    else child.stdin.end(script)
  })
}

/**
 * Mark a remote scan as coming from `host`. Keys are prefixed too, so a card
 * can never be confused with one from another machine that happens to have
 * the same pid.
 */
export function tagRemote(result: ScanResult, host: string): ScanResult {
  return {
    ...result,
    host,
    sessions: result.sessions.map((s) => ({ ...s, host, key: `${host}/${s.key}` })),
  }
}
