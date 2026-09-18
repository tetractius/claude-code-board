import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Toolbar, { type SortKey } from './components/Toolbar.tsx'
import BoardGrid from './components/BoardGrid.tsx'
import CommandModal, { type CommandBlock, type ModalKind } from './components/CommandModal.tsx'
import { canFocusTty } from './components/SessionCard.tsx'
import SettingsModal from './components/SettingsModal.tsx'
import { api } from './lib/api.ts'
import { projectName } from './lib/format.ts'
import { columnCount, isTypingTarget, step, type Direction } from './lib/navigation.ts'
import {
  DEFAULT_CONFIG,
  TERMINAL_STATUS,
  type BoardConfig,
  type BoardSession,
  type NoteMap,
  type ScanResult,
  type Status,
} from '../core/types.ts'

interface Command {
  kind: ModalKind
  title: string
  blocks: CommandBlock[]
  warnings?: string[]
}

export default function App() {
  const [scan, setScan] = useState<ScanResult>({ sessions: [], scannedAt: 0 })
  const [notes, setNotes] = useState<NoteMap>({})
  const [config, setConfig] = useState<BoardConfig>(DEFAULT_CONFIG)
  const [scanning, setScanning] = useState(true)

  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [showFinished, setShowFinished] = useState(false)
  const [sort, setSort] = useState<SortKey>('activity')

  const [command, setCommand] = useState<Command | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [checkedKeys, setCheckedKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [headlessOnly, setHeadlessOnly] = useState(false)
  const [focusError, setFocusError] = useState<{ key: string; message: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  // Initial load, then sit on the push channel - the renderer never polls.
  useEffect(() => {
    void Promise.all([api.loadNotes(), api.loadConfig(), api.scan()]).then(
      ([loadedNotes, loadedConfig, first]) => {
        setNotes(loadedNotes)
        setConfig(loadedConfig)
        setScan(first)
        setScanning(false)
      },
    )
    return api.onSessions((result) => {
      setScan(result)
      setScanning(false)
    })
  }, [])

  // Re-render on a timer so the "4m ago" labels stay honest between scans.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  /*
   * Every callback handed to a card is stable, so that a scan push cannot
   * invalidate the memo on cards whose own data did not change.
   */
  const onNoteSaved = useCallback((sessionId: string, text: string) => {
    setNotes((prev) => {
      if (!text.trim()) {
        const { [sessionId]: _dropped, ...rest } = prev
        return rest
      }
      return { ...prev, [sessionId]: { ...prev[sessionId], text, updatedAt: Date.now() } }
    })
  }, [])

  const onResume = useCallback((s: BoardSession) => {
    void api.resumeCommand(s).then((cmd) =>
      setCommand({
        kind: 'resume',
        title: `Resume · ${s.title}`,
        blocks: [
          {
            title: 'Resume this session',
            note: s.needsRestart
              ? `Running ${s.version}. Resuming starts a new process on the installed ` +
                'build, which is what "Restart to update" is asking for.'
              : undefined,
            command: cmd,
          },
        ],
      }),
    )
  }, [])

  const onDelete = useCallback((s: BoardSession) => {
    void api.deletePanel(s).then((panel) =>
      setCommand({
        kind: 'delete',
        title: `Delete · ${s.title}`,
        blocks: panel.blocks,
        warnings: panel.warnings,
      }),
    )
  }, [])

  const onSelect = useCallback((key: string) => setSelectedKey(key), [])

  const onToggleChecked = useCallback((key: string) => {
    setCheckedKeys((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])

  const onClearChecked = useCallback(() => setCheckedKeys(new Set()), [])

  /**
   * Jump to the terminal a session is running in. Shared by the tty chip and
   * the Enter key, so both behave identically - including doing nothing at all
   * for a session that has no terminal to jump to.
   */
  const onFocusTty = useCallback((s: BoardSession) => {
    if (!canFocusTty(s)) return
    setFocusError(null)
    void api.focusTty(s.where.label).catch((err: Error) => {
      const message = err.message.replace(/^Error invoking remote method '[^']*': Error: /, '')
      setFocusError({ key: s.key, message })
      setTimeout(() => setFocusError((prev) => (prev?.key === s.key ? null : prev)), 4000)
    })
  }, [])

  const onRefresh = useCallback(() => {
    setScanning(true)
    void api.scan().then((r) => {
      setScan(r)
      setScanning(false)
    })
  }, [])

  const onSaveConfig = useCallback((patch: Partial<BoardConfig>) => {
    void api.saveConfig(patch).then(setConfig)
  }, [])

  const projects = useMemo(
    () => [...new Set(scan.sessions.map((s) => projectName(s.cwd)))].sort(),
    [scan.sessions],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = scan.sessions.filter((s) => {
      if (headlessOnly && !s.headless) return false
      if (!showFinished && TERMINAL_STATUS.has(s.status)) return false
      if (project !== 'all' && projectName(s.cwd) !== project) return false
      if (!needle) return true
      return (
        s.title.toLowerCase().includes(needle) ||
        s.cwd.toLowerCase().includes(needle) ||
        s.sessionId.toLowerCase().includes(needle) ||
        (notes[s.sessionId]?.text ?? '').toLowerCase().includes(needle)
      )
    })

    // The scanner already returns attention-first, activity-desc order; only
    // re-sort when a different key is chosen.
    if (sort === 'title') return [...filtered].sort((a, b) => a.title.localeCompare(b.title))
    if (sort === 'project') {
      return [...filtered].sort(
        (a, b) =>
          projectName(a.cwd).localeCompare(projectName(b.cwd)) || b.lastActivity - a.lastActivity,
      )
    }
    return filtered
  }, [scan.sessions, query, project, showFinished, headlessOnly, sort, notes])

  const headlessCount = useMemo(
    () => scan.sessions.filter((s) => s.headless).length,
    [scan.sessions],
  )

  const staleCount = useMemo(
    () => scan.sessions.filter((s) => s.needsRestart).length,
    [scan.sessions],
  )

  /*
   * Keep the selection pointing at a card that still exists. Scans land about
   * once a second and can retire a session out from under the cursor.
   */
  useEffect(() => {
    if (selectedKey && !visible.some((s) => s.key === selectedKey)) setSelectedKey(null)
  }, [visible, selectedKey])

  // Keep the selected card on screen as the arrow keys walk the grid.
  useEffect(() => {
    if (!selectedKey) return
    gridRef.current
      ?.querySelector(`[data-card="${CSS.escape(selectedKey)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey])

  const move = useCallback(
    (direction: Direction) => {
      if (visible.length === 0) return
      const cols = columnCount(gridRef.current)
      const current = visible.findIndex((s) => s.key === selectedKey)
      // Nothing selected yet: any arrow key enters the grid at the first card.
      setSelectedKey(
        current === -1
          ? visible[0].key
          : visible[step(current, direction, cols, visible.length)].key,
      )
    },
    [visible, selectedKey],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A modal owns the keyboard while it is open.
      if (command || settingsOpen) return

      if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }

      const typing = isTypingTarget(e.target)
      const inSearch = e.target === searchRef.current

      if (e.key === 'Escape') {
        if (typing) (e.target as HTMLElement).blur()
        else setSelectedKey(null)
        return
      }

      // Enter or Down in the search box hands off to the grid, so you can go
      // from typing a filter to walking the results without touching the mouse.
      if (inSearch) {
        if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault()
          if (visible.length === 0) return
          searchRef.current?.blur()
          setSelectedKey(visible[0].key)
        }
        return
      }

      // Arrow keys belong to the note being edited, not to the board.
      if (typing) return

      // `e` drops into the selected card's note. Enter there hands control
      // straight back, so a note can be written without touching the mouse.
      if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey && selectedKey) {
        const note = gridRef.current?.querySelector<HTMLTextAreaElement>(
          `[data-card="${CSS.escape(selectedKey)}"] textarea`,
        )
        if (note) {
          e.preventDefault()
          note.focus()
          note.setSelectionRange(note.value.length, note.value.length)
        }
        return
      }

      const directions: Record<string, Direction> = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
      }
      if (directions[e.key]) {
        e.preventDefault()
        move(directions[e.key])
        return
      }

      if (e.key === ' ' && selectedKey) {
        e.preventDefault()
        onToggleChecked(selectedKey)
        return
      }

      if (e.key === 'Enter' && selectedKey) {
        e.preventDefault()
        const session = visible.find((s) => s.key === selectedKey)
        // A no-op for sessions with no terminal to jump to, by design.
        if (session) onFocusTty(session)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, selectedKey, move, onFocusTty, onToggleChecked, command, settingsOpen])

  const onSelectAllShown = useCallback(() => {
    setCheckedKeys(new Set(visible.map((s) => s.key)))
  }, [visible])

  const onDeleteChecked = useCallback(() => {
    const chosen = scan.sessions.filter((s) => checkedKeys.has(s.key))
    if (chosen.length === 0) return
    void api.bulkDeletePanel(chosen).then((panel) =>
      setCommand({
        kind: 'delete',
        title: `Delete · ${chosen.length} session${chosen.length === 1 ? '' : 's'}`,
        blocks: panel.blocks,
        warnings: panel.warnings,
      }),
    )
  }, [scan.sessions, checkedKeys])

  /* Drop ticks for sessions that have since disappeared from the board. */
  useEffect(() => {
    setCheckedKeys((prev) => {
      if (prev.size === 0) return prev
      const alive = new Set(scan.sessions.map((s) => s.key))
      const next = new Set([...prev].filter((k) => alive.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [scan.sessions])

  const counts = useMemo(() => {
    const out: Partial<Record<Status, number>> = {}
    for (const s of scan.sessions) out[s.status] = (out[s.status] ?? 0) + 1
    return out
  }, [scan.sessions])

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        searchRef={searchRef}
        query={query}
        onQuery={setQuery}
        projects={projects}
        activeProject={project}
        onProject={setProject}
        showFinished={showFinished}
        onShowFinished={setShowFinished}
        sort={sort}
        onSort={setSort}
        counts={counts}
        staleCount={staleCount}
        headlessOnly={headlessOnly}
        onHeadlessOnly={setHeadlessOnly}
        headlessCount={headlessCount}
        checkedCount={checkedKeys.size}
        onSelectAllShown={onSelectAllShown}
        onClearChecked={onClearChecked}
        onDeleteChecked={onDeleteChecked}
        total={scan.sessions.length}
        shown={visible.length}
        onRefresh={onRefresh}
        onSettings={() => setSettingsOpen(true)}
        scanning={scanning}
      />

      {scan.error && (
        <div className="shrink-0 border-b border-clot/50 bg-clot/15 px-4 py-2 text-[12px] text-artery">
          {scan.error}
        </div>
      )}

      <main className="min-h-0 flex-1 overflow-y-auto">
        {scanning && scan.scannedAt === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-ash">
            Scanning sessions…
          </div>
        ) : (
          <BoardGrid
            sessions={visible}
            notes={notes}
            selectedKey={selectedKey}
            checkedKeys={checkedKeys as Set<string>}
            focusError={focusError}
            gridRef={gridRef}
            onNoteSaved={onNoteSaved}
            onResume={onResume}
            onDelete={onDelete}
            onSelect={onSelect}
            onToggleChecked={onToggleChecked}
            onFocusTty={onFocusTty}
          />
        )}
      </main>

      {command && <CommandModal {...command} onClose={() => setCommand(null)} />}
      {settingsOpen && (
        <SettingsModal
          config={config}
          onSave={onSaveConfig}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
