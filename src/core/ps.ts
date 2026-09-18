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
}

/**
 * `claude agents --json` reports a pid but no tty, and macOS has no /proc, so
 * `ps` is the only way to find out which terminal a session is sitting in.
 */
export async function buildProcIndex(): Promise<Map<number, ProcInfo>> {
  const index = new Map<number, ProcInfo>()
  let stdout: string
  try {
    ;({ stdout } = await run('ps', ['-Ao', 'pid=,ppid=,tty=,comm='], {
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
    index.set(pid, { pid, ppid: Number(m[2]), tty: m[3], comm: m[4].trim() })
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
