import { NEEDS_ATTENTION, TERMINAL_STATUS, type BoardSession, type Status } from './types.ts'

/** Each session's status at the previous scan, keyed on `BoardSession.key`. */
export type StatusSnapshot = Map<string, Status>

export function snapshot(sessions: BoardSession[]): StatusSnapshot {
  return new Map(sessions.map((s) => [s.key, s.status]))
}

/**
 * Sessions that started needing a human since the previous scan.
 *
 * Only the transition counts, so a session that stays blocked notifies once,
 * not on every scan. With no previous scan there is nothing to compare against:
 * whatever is already waiting when the board opens is on screen anyway, and
 * announcing all of it at launch is noise.
 */
export function newlyNeedingAttention(
  previous: StatusSnapshot | null,
  sessions: BoardSession[],
): BoardSession[] {
  if (!previous) return []
  return sessions.filter((s) => {
    if (!NEEDS_ATTENTION.has(s.status)) return false
    const before = previous.get(s.key)
    return before === undefined || !NEEDS_ATTENTION.has(before)
  })
}

/** Statuses that mean the session is in the middle of a turn. */
const RUNNING: ReadonlySet<Status> = new Set<Status>(['busy', 'working'])

/**
 * Sessions that finished a turn since the previous scan: busy or working
 * before, and now idle or done. A turn that ends by asking for something is
 * already announced by `newlyNeedingAttention`, so it is not counted twice.
 */
export function newlyFinished(
  previous: StatusSnapshot | null,
  sessions: BoardSession[],
): BoardSession[] {
  if (!previous) return []
  return sessions.filter((s) => {
    const before = previous.get(s.key)
    return (
      before !== undefined &&
      RUNNING.has(before) &&
      !RUNNING.has(s.status) &&
      !NEEDS_ATTENTION.has(s.status) &&
      s.status !== 'exited'
    )
  })
}

/**
 * Still open, but nobody has touched it for `hours`: a terminal tab left
 * behind. Anything suspended counts straight away, since it does nothing until
 * someone finds its tab. Sessions mid-turn or waiting on you never do.
 */
export function isDormant(s: BoardSession, hours: number, now = Date.now()): boolean {
  if (!s.live || TERMINAL_STATUS.has(s.status) || NEEDS_ATTENTION.has(s.status)) return false
  if (s.suspended) return true
  if (RUNNING.has(s.status)) return false
  return now - s.lastActivity > hours * 3_600_000
}

/** One line saying what the session wants, for the notification body. */
export function attentionSummary(s: BoardSession): string {
  return s.needs || s.waitingFor || (s.status === 'blocked' ? 'Blocked' : 'Waiting for you')
}
