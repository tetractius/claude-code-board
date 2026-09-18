import type { RefObject } from 'react'
import SessionCard from './SessionCard.tsx'
import type { BoardSession, NoteMap } from '../../core/types.ts'

interface Props {
  sessions: BoardSession[]
  notes: NoteMap
  selectedKey: string | null
  checkedKeys: Set<string>
  focusError: { key: string; message: string } | null
  /** So keyboard navigation can read the live column count off the grid. */
  gridRef: RefObject<HTMLDivElement | null>
  onNoteSaved: (sessionId: string, text: string) => void
  onResume: (s: BoardSession) => void
  onDelete: (s: BoardSession) => void
  onSelect: (key: string) => void
  onToggleChecked: (key: string) => void
  onFocusTty: (s: BoardSession) => void
}

/**
 * The layout is pure CSS: `auto-fill` with a minimum track width means a narrow
 * or portrait window collapses to a single column and a wide one fills with as
 * many columns as fit, with no resize listeners involved.
 */
export default function BoardGrid({
  sessions,
  notes,
  selectedKey,
  checkedKeys,
  focusError,
  gridRef,
  onNoteSaved,
  onResume,
  onDelete,
  onSelect,
  onToggleChecked,
  onFocusTty,
}: Props) {
  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-ash">
        No sessions match.
      </div>
    )
  }

  return (
    <div
      ref={gridRef}
      className="grid grid-cols-[repeat(auto-fill,minmax(330px,1fr))] gap-3 p-4"
    >
      {sessions.map((s) => (
        <SessionCard
          key={s.key}
          session={s}
          noteText={notes[s.sessionId]?.text ?? ''}
          selected={selectedKey === s.key}
          checked={checkedKeys.has(s.key)}
          onToggleChecked={onToggleChecked}
          focusError={focusError?.key === s.key ? focusError.message : undefined}
          onNoteSaved={onNoteSaved}
          onResume={onResume}
          onDelete={onDelete}
          onSelect={onSelect}
          onFocusTty={onFocusTty}
        />
      ))}
    </div>
  )
}
