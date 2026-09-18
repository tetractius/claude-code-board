import { statusStyle } from '../lib/format.ts'
import type { Status } from '../../core/types.ts'

interface Props {
  status: Status
  waitingFor?: string
  /** Explains an unhelpful status, rather than leaving it looking broken. */
  hint?: string
}

export default function StatusBadge({ status, waitingFor, hint }: Props) {
  const style = statusStyle(status)
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={hint}>
      <span
        className={`size-2 shrink-0 rounded-full ${style.dot} ${
          style.urgent ? 'pulse-dot' : style.active ? 'breathe-dot' : ''
        }`}
      />
      <span className="text-[11px] font-medium tracking-wider uppercase">{style.label}</span>
      {waitingFor && (
        <span className="truncate text-[11px] text-artery" title={waitingFor}>
          · {waitingFor}
        </span>
      )}
    </span>
  )
}
