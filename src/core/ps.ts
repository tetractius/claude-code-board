import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface ProcInfo {
  pid: number
  ppid: number
  /** e.g. `ttys011`, or `??` for a process with no controlling terminal. */
  tty: string
  /** Executable path, used to guard against pid reuse. */
  comm: string
  /** Full command line, which carries `--resume <uuid>` when there is one. */
  args: string
  /** `ps` state flags, e.g. `S+`; a leading `T` means stopped by a signal. */
  stat: string
  /** When it started, in ms since the epoch - to the second, from `ps`'s elapsed time. */
  startedAt?: number
}

/**
 * `ps`'s `etime`, `[[dd-]hh:]mm:ss`, in seconds. POSIX, so the same on macOS
 * and Linux - unlike `etimes` or `lstart`, which is also in the local language.
 */
export function parseElapsed(etime: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!m) return undefined
  const [d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0))
  return ((d * 24 + h) * 60 + min) * 60 + s
}

/**
 * `claude agents --json` reports a pid but no tty, and macOS has no /proc, so
 * `ps` is the only way to find out which terminal a session is sitting in.
 */
export async function buildProcIndex(): Promise<Map<number, ProcInfo>> {
  const index = new Map<number, ProcInfo>()
  let stdout: string
  try {
    ;({ stdout } = await run('ps', ['-Ao', 'pid=,ppid=,tty=,stat=,etime=,args='], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    }))
  } catch {
    return index
  }

  const now = Date.now()
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const args = m[6].trim()
    const elapsed = parseElapsed(m[5])
    // `comm` is just the argv[0] of `args`; one ps call cannot emit both.
    index.set(pid, {
      pid,
      ppid: Number(m[2]),
      tty: m[3],
      stat: m[4],
      comm: args.split(' ')[0],
      args,
      startedAt: elapsed === undefined ? undefined : now - elapsed * 1000,
    })
  }
  return index
}

/**
 * Pids are recycled, and `~/.claude/sessions/` accumulates entries for dead
 * ones. Requiring the live process to actually be a claude binary is a simpler
 * and more reliable guard than comparing start times, which the registry and
 * `ps` render in different timezone offsets.
 */
export function isClaudeProcess(info: ProcInfo | undefined): boolean {
  return !!info && /(^|\/)claude(\.app)?($|\/|\s)/i.test(info.comm)
}

/**
 * The terminal a process is attached to, or null when `ps` shows none.
 *
 * A process with no controlling terminal prints `??` on macOS but a single `?`
 * on Linux, where terminals are `pts/N` rather than `ttysNNN`. Matching only
 * the macOS spelling gave every headless session on Linux a terminal named
 * `?` - and made `stopSession` refuse it as having "moved terminals".
 */
export function terminalOf(info: ProcInfo | undefined): string | null {
  const tty = info?.tty
  return tty && !tty.startsWith('?') && tty !== '-' ? tty : null
}

/**
 * Stopped by job control - Ctrl+Z in the terminal, or SIGSTOP. The process is
 * alive, so every other source still reports it as running, but it does
 * nothing until someone runs `fg` in that terminal. Typically it is hidden
 * behind whatever was started in the same tab afterwards.
 *
 * The leading `T` is POSIX `ps` state, not a macOS quirk: Linux reports a
 * stopped process as `T` too (and a running one as `Ss+`, `S+`, ...), so this
 * needs no platform guard.
 */
export function isSuspended(info: ProcInfo | undefined): boolean {
  return !!info && info.stat.startsWith('T')
}

/**
 * In the foreground process group of its terminal - the `+` in `ps` state.
 * Of several processes on one tty, this is the one actually on screen.
 *
 * Like `T`, the `+` flag is POSIX: a Linux pty reports `Ss+` / `S+` the same
 * way, so this needs no platform guard either.
 */
export function isForeground(info: ProcInfo | undefined): boolean {
  return !!info && info.stat.includes('+')
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/

/**
 * The session id a process was launched to resume, from its command line.
 *
 * This is the only exact pid -> session link left: Claude 2.1.28x stopped
 * writing the `<pid>.json` registry that used to carry it.
 */
export function resumedSessionId(info: ProcInfo | undefined): string | undefined {
  if (!info || !/(^|\s)(--resume|-r)(\s|=)/.test(info.args)) return undefined
  return UUID.exec(info.args)?.[0]
}

/**
 * Launched with `--continue`: it carries on the project's most recent session,
 * which is on disk from before it started.
 */
export function continuesLatest(info: ProcInfo | undefined): boolean {
  return !!info && /(^|\s)(--continue|-c)(\s|$)/.test(info.args)
}
