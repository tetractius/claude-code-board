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
}

/**
 * `claude agents --json` reports a pid but no tty, and macOS has no /proc, so
 * `ps` is the only way to find out which terminal a session is sitting in.
 */
export async function buildProcIndex(): Promise<Map<number, ProcInfo>> {
  const index = new Map<number, ProcInfo>()
  let stdout: string
  try {
    ;({ stdout } = await run('ps', ['-Ao', 'pid=,ppid=,tty=,args='], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    }))
  } catch {
    return index
  }

  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const pid = Number(m[1])
    const args = m[4].trim()
    // `comm` is just the argv[0] of `args`; one ps call cannot emit both.
    index.set(pid, { pid, ppid: Number(m[2]), tty: m[3], comm: args.split(' ')[0], args })
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
