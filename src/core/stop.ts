import { buildProcIndex, isClaudeProcess, isSuspended, terminalOf } from './ps.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * End a live session with SIGTERM, which Claude handles by exiting cleanly.
 * The conversation is already on disk, so the session can be resumed
 * afterwards.
 *
 * Right before signalling, checks the pid is still Claude on the same
 * terminal (`tty` is null for a session with none). Pids are recycled, the
 * card may be several seconds old, and with many sessions open the pid could
 * now belong to a different conversation.
 *
 * A session stopped with Ctrl+Z gets SIGKILL instead. Woken with SIGCONT, its
 * SIGTERM cleanup touches the terminal from the background, which stops it
 * again (SIGTTOU), so it never exits. Killing it loses nothing: Claude already
 * handed the terminal back when it was suspended, and the conversation is
 * saved after every message.
 *
 * Resolves true once the process is gone, false if it is still shutting down
 * after `waitMs`. A running session is never escalated to SIGKILL: that is the
 * user's call.
 */
export async function stopSession(
  pid: number,
  tty: string | null,
  waitMs = 5000,
): Promise<boolean> {
  const proc = (await buildProcIndex()).get(pid)
  if (!isClaudeProcess(proc) || terminalOf(proc) !== tty) {
    throw new Error(`pid ${pid} is no longer this session.`)
  }

  try {
    process.kill(pid, isSuspended(proc) ? 'SIGKILL' : 'SIGTERM')
  } catch (err) {
    // It exited on its own between the check and the signal.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw err
  }

  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250)
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
  }
  return false
}
