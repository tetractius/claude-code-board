import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RemoteHost, isValidHost, tagRemote } from '../core/remote.ts'
import type { ScanResult } from '../core/types.ts'

/**
 * Which machine the board is showing, and the SSH connections behind it.
 *
 * The board starts on this machine every time. Choosing a host opens one
 * long-lived connection to it (see core/remote.ts); choosing another closes
 * it, so nothing keeps running on a host nobody is looking at.
 */

/** Built by scripts/build-remote.mjs into out/remote, next to this file's out/main. */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../remote/board-remote.mjs')

let script: Promise<Buffer> | null = null
function loadScript(): Promise<Buffer> {
  script ??= readFile(SCRIPT).catch(() => {
    script = null
    throw new Error(`The remote scanner is missing (${SCRIPT}). Run \`npm run build:remote\`.`)
  })
  return script
}

let active = ''
const remotes = new Map<string, RemoteHost>()
/** The claude binary each host's scan found, for resume commands run there. */
const claudeBins = new Map<string, string>()

/** The host being shown; '' is this machine. */
export function activeHost(): string {
  return active
}

/** Only a configured host can be shown, so nothing else ever reaches ssh. */
export function setActiveHost(host: string, configured: readonly string[]): void {
  if (host && !(isValidHost(host) && configured.includes(host))) {
    throw new Error(`${host} is not one of the hosts in Settings.`)
  }
  if (host === active) return
  remotes.get(active)?.close()
  remotes.delete(active)
  active = host
}

async function remoteFor(host: string): Promise<RemoteHost> {
  let remote = remotes.get(host)
  if (!remote) {
    remote = new RemoteHost(host, { script: await loadScript() })
    remotes.set(host, remote)
  }
  return remote
}

/**
 * A scan of `host`, tagged with it. Never throws: an unreachable host is a
 * board with an error banner saying why, like a local scan that failed.
 */
export async function scanHost(
  host: string,
  opts: { finishedLimit: number; contextWindow: number },
): Promise<ScanResult> {
  try {
    const result = await (await remoteFor(host)).scan(opts)
    if (result.claudeBin) claudeBins.set(host, result.claudeBin)
    return tagRemote(result, host)
  } catch (err) {
    return { sessions: [], scannedAt: Date.now(), host, error: (err as Error).message }
  }
}

export function remoteClaudeBin(host: string): string | undefined {
  return claudeBins.get(host)
}

/** Stop a session on the host being shown; the identity check runs over there. */
export async function stopRemote(host: string, pid: number, tty: string | null): Promise<boolean> {
  if (host !== active) throw new Error(`${host} is not the host being shown.`)
  return (await remoteFor(host)).stop(pid, tty)
}

/**
 * The Settings "Test" button: connect, scan once, and say what is there. Uses
 * its own connection, so a test never disturbs the board.
 */
export async function testHost(host: string): Promise<string> {
  if (!isValidHost(host)) throw new Error(`Not a host name: ${host}`)
  const remote = new RemoteHost(host, { script: await loadScript() })
  try {
    const hello = await remote.connect()
    const result = await remote.scan({ finishedLimit: 1 })
    const claude = result.claudeVersion ? `, Claude ${result.claudeVersion.split(' ')[0]}` : ''
    const live = result.sessions.filter((s) => s.live).length
    const summary = `Connected: Node ${hello.node} on ${hello.platform}${claude}, ${live} live session${live === 1 ? '' : 's'}.`
    return result.error ? `${summary} But: ${result.error}` : summary
  } finally {
    remote.close()
  }
}

export function closeAll(): void {
  for (const remote of remotes.values()) remote.close()
  remotes.clear()
}
