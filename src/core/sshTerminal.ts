import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { buildProcIndex, terminalOf, type ProcInfo } from './ps.ts'
import { focusTty } from './terminal.ts'
import type { BoardSession } from './types.ts'

const run = promisify(execFile)

/**
 * Finding the local terminal tab a remote session is sitting in.
 *
 * A session on another host runs on that host's pty, which no local terminal
 * knows about. What connects the two is the `ssh` process in the local tab:
 * its TCP connection's source port is the client port the remote session sees
 * in `SSH_CONNECTION`. So the exact match is local ssh process -> its source
 * port -> the remote session reporting that port.
 *
 * The exact match fails when ssh multiplexes (ControlMaster: the tab's ssh
 * has no socket of its own), connects through a jump host, or when the
 * session runs in a tmux that outlived the connection it was started from.
 * Then a single tab connected to that host is taken as the one; with several,
 * there is no telling which, and the board does nothing rather than guess.
 */

/** Options of OpenSSH's `ssh` that take a value, from its getopt string. */
const WITH_VALUE = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''))

/**
 * The host an `ssh` command line connects to, from the args `ps` shows -
 * `ssh -p 2222 me@devbox` is `devbox`. Null when it is not a connection
 * (`ssh -V`) or the destination cannot be found.
 */
export function sshDestination(args: string): string | null {
  const tokens = args.trim().split(/\s+/).slice(1)
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '--') return hostPart(tokens[i + 1])
    if (t.startsWith('-') && t.length > 1) {
      // Flags can be bundled (`-tA`); the first one that takes a value ends
      // the bundle, with the value attached or as the next token.
      for (let j = 1; j < t.length; j++) {
        if (WITH_VALUE.has(t[j])) {
          if (j === t.length - 1) i++
          break
        }
      }
      continue
    }
    return hostPart(t)
  }
  return null
}

function hostPart(destination: string | undefined): string | null {
  if (!destination) return null
  let d = destination.replace(/^ssh:\/\//, '')
  d = d.slice(d.lastIndexOf('@') + 1)
  if (destination.startsWith('ssh://')) d = d.replace(/:\d+$/, '')
  d = d.replace(/^\[(.*)\]$/, '$1')
  return d || null
}

export interface SshClient {
  pid: number
  /** The local terminal it runs in; null for a background or master ssh. */
  tty: string | null
}

/** Local `ssh` processes connected to `host`. */
export function sshClientsFor(host: string, procs: Map<number, ProcInfo>): SshClient[] {
  const want = host.toLowerCase()
  const out: SshClient[] = []
  for (const p of procs.values()) {
    if (basename(p.comm) !== 'ssh') continue
    if (sshDestination(p.args)?.toLowerCase() !== want) continue
    out.push({ pid: p.pid, tty: terminalOf(p) })
  }
  return out
}

/**
 * Local TCP source ports of each pid's established connections, from `lsof -F`
 * output: `p<pid>` starts a process, `n<local>-><remote>` is one connection.
 */
export function parseLsofPorts(output: string): Map<number, number[]> {
  const ports = new Map<number, number[]>()
  let pid = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
    } else if (line.startsWith('n') && pid) {
      const local = line.slice(1).split('->')[0]
      const port = Number(local.slice(local.lastIndexOf(':') + 1))
      if (Number.isInteger(port) && port > 0) {
        ports.set(pid, [...(ports.get(pid) ?? []), port])
      }
    }
  }
  return ports
}

/**
 * The tty of the local tab a remote session is in, or null when there is no
 * telling. See the comment at the top of this file for the two rules.
 */
export function pickTerminal(
  clients: SshClient[],
  ports: Map<number, number[]>,
  clientPort: number | undefined,
): string | null {
  if (clientPort) {
    const exact = clients.find((c) => c.tty && ports.get(c.pid)?.includes(clientPort))
    if (exact) return exact.tty
  }
  const inTabs = clients.filter((c) => c.tty)
  return inTabs.length === 1 ? inTabs[0].tty : null
}

async function localPorts(pids: number[]): Promise<Map<number, number[]>> {
  if (pids.length === 0) return new Map()
  try {
    const { stdout } = await run(
      'lsof',
      ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:ESTABLISHED', '-Fpn'],
      { timeout: 10_000 },
    )
    return parseLsofPorts(stdout)
  } catch (err) {
    // lsof exits 1 when nothing matched, and still prints what it found.
    return parseLsofPorts((err as { stdout?: string }).stdout ?? '')
  }
}

/**
 * Bring the local terminal tab connected to a remote session to the front.
 * Resolves to the app that was focused, or '' when no tab could be found -
 * never throws, since finding nothing is an expected outcome here.
 */
export async function focusRemoteSession(s: BoardSession): Promise<string> {
  if (process.platform !== 'darwin' || !s.host) return ''
  try {
    const clients = sshClientsFor(s.host, await buildProcIndex())
    const ports = s.sshClientPort ? await localPorts(clients.map((c) => c.pid)) : new Map()
    const tty = pickTerminal(clients, ports, s.sshClientPort)
    return tty ? await focusTty(tty) : ''
  } catch {
    return ''
  }
}
