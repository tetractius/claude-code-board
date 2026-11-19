import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
 * Only a host name is ever configured. Everything else - user, port, identity
 * file, jump hosts, multiplexing - is ssh's business, read from
 * `~/.ssh/config` as it would be for any other `ssh <host>`. Connections run
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

export interface RemoteOptions {
  /** The bundled remote scanner, exactly as it will be uploaded. */
  script: Buffer
  /** The ssh executable. Tests substitute a stand-in that runs locally. */
  sshBin?: string
  /** How long to wait for the remote scanner to come up, upload included. */
  connectTimeoutMs?: number
}

/**
 * Run by the remote's `sh -s`. Everything is inside one function, called on
 * the last line, so the shell has read the whole script before running any
 * of it: `head -c` then reads the upload from the same stdin, and the shell
 * cannot have consumed any of it as script, nor the script as upload.
 *
 * Node is looked for on PATH, then on a login shell's PATH and an interactive
 * one's (where nvm, fnm and volta usually put it), then in the usual places.
 */
export function bootstrapScript(hash: string, size: number): string {
  const say = (json: string) => `printf '%s\\n' '${MARK}${json}'`
  return `main() {
  d="$HOME/.claude-board/remote"
  f="$d/board-remote-${hash}.mjs"
  node=
  pick() { [ -z "$node" ] && [ -n "$1" ] && [ -x "$1" ] && node=$1; return 0; }
  pick "$(command -v node 2>/dev/null)"
  pick "$("\${SHELL:-sh}" -lc 'command -v node' </dev/null 2>/dev/null | tail -n 1)"
  pick "$("\${SHELL:-sh}" -ic 'command -v node' </dev/null 2>/dev/null | tail -n 1)"
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do pick "$c"; done
  if [ -z "$node" ]; then ${say('{"stage":"error","reason":"no-node"}')}; return; fi
  if ! "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
    printf '%s{"stage":"error","reason":"old-node","node":"%s"}\\n' '${MARK}' "$("$node" -v 2>/dev/null)"
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
main
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
  return `${host}: ${last || `ssh exited with code ${code ?? 'unknown'}`}`
}

function explainStage(host: string, stage: { reason?: string; node?: string }): string {
  switch (stage.reason) {
    case 'no-node':
      return `${host}: no Node.js found. The board runs its scanner there with Node 18 or newer - install it, or put it on the PATH of a login shell.`
    case 'old-node':
      return `${host}: Node ${stage.node || '(unknown version)'} is too old. The board needs Node 18 or newer there.`
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
            fail(new Error(explainStage(this.host, msg)))
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

      child.stdin.write(bootstrapScript(this.hash, script.length))
    })
  }
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
