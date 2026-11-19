/**
 * The board's scanner, run on a remote host over SSH.
 *
 * The board uploads this file (bundled with src/core into one script, see
 * scripts/build-remote.mjs) and starts it with `--serve`. It then answers
 * requests on stdin, one JSON object per line, until the connection closes.
 * Staying up between scans is the point: the transcript cache in
 * core/transcripts.ts stays warm, so a scan every few seconds re-reads only
 * what changed instead of every transcript on the machine.
 *
 * Every line it writes starts with `@@board `. A login shell that prints
 * something - a motd, an `echo` in .bashrc - cannot be mistaken for a reply.
 *
 * Plain Node, no dependencies: the remote needs Node 18+ and nothing else.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { scan } from '../core/scanner.ts'
import { stopSession } from '../core/stop.ts'
import type { BoardSession, ScanResult } from '../core/types.ts'

/** Bumped when a request or reply changes shape. */
export const PROTOCOL = 1

export const MARK = '@@board '

interface Request {
  id: number
  op: string
  args?: Record<string, unknown>
}

/**
 * The client port of the SSH connection a process was started over. Every
 * login over SSH exports `SSH_CONNECTION="client_ip client_port server_ip
 * server_port"`, and the session inherits it, so this names the local `ssh`
 * process - and through it the local terminal tab - the session is sitting in.
 *
 * Linux only, from /proc; elsewhere there is no cheap way to read another
 * process's environment, and the board falls back to a weaker match.
 */
async function sshClientPort(pid: number): Promise<number | undefined> {
  if (process.platform !== 'linux') return undefined
  try {
    const env = await readFile(`/proc/${pid}/environ`, 'utf8')
    const line = env.split('\0').find((v) => v.startsWith('SSH_CONNECTION='))
    const port = Number(line?.split(' ')[1])
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

async function withSshOrigin(sessions: BoardSession[]): Promise<BoardSession[]> {
  return Promise.all(
    sessions.map(async (s) =>
      s.live && s.pid !== undefined && s.where.type === 'tty'
        ? { ...s, sshClientPort: await sshClientPort(s.pid) }
        : s,
    ),
  )
}

export async function handle(req: Request): Promise<unknown> {
  const args = req.args ?? {}
  switch (req.op) {
    case 'scan': {
      const result: ScanResult = await scan({
        finishedLimit: typeof args.finishedLimit === 'number' ? args.finishedLimit : undefined,
        contextWindow: typeof args.contextWindow === 'number' ? args.contextWindow : undefined,
        terminalTitles: false,
      })
      return { ...result, sessions: await withSshOrigin(result.sessions) }
    }
    case 'stop': {
      const pid = Number(args.pid)
      if (!Number.isInteger(pid) || pid <= 1) throw new Error(`not a pid: ${args.pid}`)
      const tty = typeof args.tty === 'string' ? args.tty : null
      return stopSession(pid, tty)
    }
    default:
      throw new Error(`unknown request: ${req.op}`)
  }
}

function reply(message: object): void {
  process.stdout.write(MARK + JSON.stringify(message) + '\n')
}

export function serve(): void {
  reply({ hello: { protocol: PROTOCOL, node: process.version, platform: process.platform } })
  const lines = createInterface({ input: process.stdin })
  let inFlight = 0
  let closed = false
  // The board hung up, or the connection dropped: finish what was asked, then
  // go - once stdout has drained, since a pipe write is asynchronous on macOS
  // and exiting straight away can cut a large scan reply short.
  const exitIfDone = () => {
    if (closed && inFlight === 0) process.stdout.end(() => process.exit(0))
  }
  lines.on('line', (line) => {
    let req: Request
    try {
      req = JSON.parse(line) as Request
    } catch {
      return
    }
    inFlight++
    handle(req)
      .then(
        (result) => reply({ id: req.id, ok: true, result }),
        (err: Error) => reply({ id: req.id, ok: false, error: err?.message ?? String(err) }),
      )
      .finally(() => {
        inFlight--
        exitIfDone()
      })
  })
  lines.on('close', () => {
    closed = true
    exitIfDone()
  })
}

if (process.argv.includes('--serve')) serve()
