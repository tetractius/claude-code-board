import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'

const SAVE_DEBOUNCE_MS = 400

interface Props {
  sessionId: string
  /** Seed value only. Deliberately not kept in sync - see below. */
  initialText: string
  cwd: string
  title: string
  /** Whether this session already has a note, for the marker on the box. */
  annotated: boolean
  /** Whether the card is the keyboard selection, for the edit hint. */
  selected: boolean
  onSaved: (sessionId: string, text: string) => void
}

/**
 * The note editor.
 *
 * The board pushes a fresh session list roughly every second. If the note text
 * were driven by that pushed state, every scan landing mid-keystroke would
 * reset the textarea's value and jump the caret. So the draft lives here, in
 * local state, seeded once per session id and never written back to from
 * props. Data flows one way: draft -> debounced save -> store.
 */
export default function NotesPanel({
  sessionId,
  initialText,
  cwd,
  title,
  annotated,
  selected,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState(initialText)
  const [saved, setSaved] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const dirty = useRef(false)
  /** Where to put the caret once React has re-rendered the new draft. */
  const pendingCaret = useRef<number | null>(null)

  // Re-seed only when the card is reused for a different session.
  useEffect(() => {
    setDraft(initialText)
    dirty.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
    if (pendingCaret.current !== null) {
      el.selectionStart = el.selectionEnd = pendingCaret.current
      pendingCaret.current = null
    }
  }, [draft])

  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      void api.setNote(sessionId, draft, { cwd, title }).then(() => {
        onSaved(sessionId, draft)
        setSaved(true)
        setTimeout(() => setSaved(false), 1200)
      })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [draft, sessionId, cwd, title, onSaved])

  const onChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    dirty.current = true
    setDraft(e.target.value)
  }, [])

  /*
   * Enter is inverted here on purpose. The board is driven from the keyboard,
   * so plain Enter hands control back to the card - otherwise there is no way
   * out of a note without reaching for the mouse. Newlines move to Cmd/Ctrl+
   * Enter, which means inserting them by hand, since preventing the default
   * also prevents the browser's own insertion and its undo entry.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key !== 'Enter') return
      const el = e.currentTarget

      if (e.metaKey || e.ctrlKey) {
        e.preventDefault()
        const start = el.selectionStart
        const end = el.selectionEnd
        dirty.current = true
        pendingCaret.current = start + 1
        setDraft((prev) => `${prev.slice(0, start)}\n${prev.slice(end)}`)
        return
      }

      e.preventDefault()
      el.blur()
    },
    [],
  )

  return (
    <div className="relative">
      <textarea
        ref={area}
        value={draft}
        onChange={onChange}
        onKeyDown={onKeyDown}
        rows={2}
        spellCheck={false}
        placeholder={selected ? 'notes…   press e to edit' : 'notes…'}
        title="Enter returns to the card · Cmd/Ctrl+Enter for a newline"
        className={`w-full resize-none rounded border bg-slab px-2 py-1.5 text-[12px]
                    leading-relaxed text-bone placeholder:text-ash/60 focus:border-mortis
                    focus:outline-none ${
                      annotated || draft.trim() ? 'border-bruise' : 'border-suture'
                    }`}
      />
      {saved && (
        <span className="pointer-events-none absolute right-2 bottom-2 text-[10px] text-verdigris">
          saved
        </span>
      )}
    </div>
  )
}
