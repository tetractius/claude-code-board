import type { Status } from '../../core/types.ts'
import { HOME } from './api.ts'

/** Collapse a leading home directory to `~`. */
export function tildify(p: string): string {
  if (p === HOME) return '~'
  return p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
}

/** `~/git/hive-mono-ENG-591` -> `hive-mono-ENG-591`, for grouping chips. */
export function projectName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

export function relativeTime(ms: number): string {
  if (!ms) return 'never'
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString()
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function shortId(uuid: string): string {
  return uuid.slice(0, 8)
}

interface StatusStyle {
  /** Tailwind background class for the dot. */
  dot: string
  label: string
  /** Insistent pulse: a human is needed. */
  urgent: boolean
  /** Gentle pulse: the session is working, but wants nothing from you. */
  active: boolean
}

/*
 * `dot` doubles as the card's left-edge accent, so a wall of cards can be read
 * by edge colour alone and the two can never drift apart.
 */
const STATUS_STYLES: Record<Status, StatusStyle> = {
  busy: { dot: 'bg-bile', label: 'busy', urgent: false, active: true },
  working: {
    dot: 'bg-bile',
    label: 'working',
    urgent: false,
    active: true,
  },
  waiting: {
    dot: 'bg-artery',
    label: 'waiting',
    urgent: true,
    active: false,
  },
  blocked: {
    dot: 'bg-artery',
    label: 'blocked',
    urgent: true,
    active: false,
  },
  idle: {
    dot: 'bg-verdigris',
    label: 'idle',
    urgent: false,
    active: false,
  },
  done: { dot: 'bg-mortis', label: 'done', urgent: false, active: false },
  failed: { dot: 'bg-clot', label: 'failed', urgent: false, active: false },
  stopped: {
    dot: 'bg-shroud',
    label: 'stopped',
    urgent: false,
    active: false,
  },
  exited: {
    dot: 'bg-shroud',
    label: 'exited',
    urgent: false,
    active: false,
  },
  unknown: {
    dot: 'bg-shroud',
    label: 'unknown',
    urgent: false,
    active: false,
  },
}

export function statusStyle(status: Status): StatusStyle {
  return STATUS_STYLES[status] ?? STATUS_STYLES.unknown
}

/** Explains where a card's "last activity" number actually came from. */
export const ACTIVITY_SOURCE_HINT: Record<string, string> = {
  status: 'from the session’s own status heartbeat',
  job: 'from the background job state',
  transcript: 'from the last message in the transcript',
  history: 'from your last prompt to this session',
  started: 'no activity recorded — showing start time',
  mtime: 'approximate — transcript file time, which Claude rewrites in bulk',
}
