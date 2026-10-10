import { NEEDS_ATTENTION, type BoardSession, type Status } from './types.ts'

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

/** One line saying what the session wants, for the notification body. */
export function attentionSummary(s: BoardSession): string {
  if (s.needs) return s.needs
  if (s.waitingFor === 'permission') return 'Needs your permission'
  if (s.waitingFor) return `Waiting for ${s.waitingFor}`
  return s.status === 'blocked' ? 'Blocked' : 'Waiting for you'
}
