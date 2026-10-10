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

/** Finished sessions not yet announced, keyed on `BoardSession.key`, with when they went idle. */
export type PendingFinishes = Map<string, number>

/**
 * Claude reports a session idle for a moment between the steps of one long
 * turn, so announcing every busy -> idle would say "Finished" several times
 * for a single answer. A finish is held until the session has stayed quiet
 * for `quietMs`; going busy again in the meantime cancels it.
 */
export function settleFinished(
  pending: PendingFinishes,
  finishedNow: BoardSession[],
  sessions: BoardSession[],
  now: number,
  quietMs = 10_000,
): BoardSession[] {
  for (const s of finishedNow) if (!pending.has(s.key)) pending.set(s.key, now)
  const byKey = new Map(sessions.map((s) => [s.key, s]))
  const ready: BoardSession[] = []
  for (const [key, at] of pending) {
    const s = byKey.get(key)
    if (!s || RUNNING.has(s.status) || NEEDS_ATTENTION.has(s.status)) {
      pending.delete(key)
    } else if (now - at >= quietMs) {
      pending.delete(key)
      ready.push(s)
    }
  }
  return ready
}

/** One line saying what the session wants, for the notification body. */
export function attentionSummary(s: BoardSession): string {
  if (s.needs) return s.needs
  if (s.waitingFor === 'permission') return 'Needs your permission'
  if (s.waitingFor) return `Waiting for ${s.waitingFor}`
  return s.status === 'blocked' ? 'Blocked' : 'Waiting for you'
}
