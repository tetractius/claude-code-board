import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { BOARD_DIR, NOTES_FILE } from './paths.ts'
import type { Note, NoteMap } from './types.ts'

/**
 * Notes live in ~/.claude-board, never inside ~/.claude: Claude's own job
 * deletion and transcript compaction both actively rewrite that tree.
 *
 * Writes are debounced and atomic (write to a temp file, then rename) so that
 * typing quickly cannot leave a half-written file behind.
 */
const WRITE_DEBOUNCE_MS = 500

let notes: NoteMap = {}
let loaded = false
let timer: NodeJS.Timeout | null = null
let inFlight: Promise<void> = Promise.resolve()

export async function loadNotes(): Promise<NoteMap> {
  if (loaded) return notes
  try {
    const parsed = JSON.parse(await readFile(NOTES_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') notes = parsed as NoteMap
  } catch {
    notes = {}
  }
  loaded = true
  return notes
}

async function persist(): Promise<void> {
  const snapshot = JSON.stringify(notes, null, 2)
  await mkdir(BOARD_DIR, { recursive: true })
  const tmp = `${NOTES_FILE}.tmp`
  await writeFile(tmp, snapshot, 'utf8')
  await rename(tmp, NOTES_FILE)
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    inFlight = inFlight.then(persist).catch((err) => {
      console.error('[board] failed to save notes:', err)
    })
  }, WRITE_DEBOUNCE_MS)
}

/**
 * `cwd` and `title` are denormalised into the note so that it still reads
 * sensibly long after Claude has garbage-collected the session it refers to.
 */
export async function setNote(
  sessionId: string,
  text: string,
  context: { cwd?: string; title?: string } = {},
): Promise<Note | null> {
  await loadNotes()
  if (!text.trim()) {
    delete notes[sessionId]
    schedule()
    return null
  }
  const note: Note = { text, updatedAt: Date.now(), ...context }
  notes[sessionId] = note
  schedule()
  return note
}

/** Flush any pending write; call on app quit. */
export async function flushNotes(): Promise<void> {
  if (timer) {
    clearTimeout(timer)
    timer = null
    inFlight = inFlight.then(persist)
  }
  await inFlight
}
