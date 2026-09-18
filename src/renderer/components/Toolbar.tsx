import type { RefObject } from 'react'
import { statusStyle } from '../lib/format.ts'
import type { Status } from '../../core/types.ts'

export type SortKey = 'activity' | 'title' | 'project'

interface Props {
  searchRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (v: string) => void
  projects: string[]
  activeProject: string
  onProject: (v: string) => void
  showFinished: boolean
  onShowFinished: (v: boolean) => void
  sort: SortKey
  onSort: (v: SortKey) => void
  counts: Partial<Record<Status, number>>
  staleCount: number
  headlessOnly: boolean
  onHeadlessOnly: (v: boolean) => void
  headlessCount: number
  checkedCount: number
  onSelectAllShown: () => void
  onClearChecked: () => void
  onDeleteChecked: () => void
  total: number
  shown: number
  onRefresh: () => void
  onSettings: () => void
  scanning: boolean
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'activity', label: 'activity' },
  { key: 'title', label: 'title' },
  { key: 'project', label: 'project' },
]

/** Statuses worth showing a running tally for, most urgent first. */
const TALLY: Status[] = ['waiting', 'blocked', 'busy', 'working', 'idle']

export default function Toolbar(p: Props) {
  return (
    <header className="drag-region shrink-0 border-b border-suture bg-crypt/80 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 pl-20">
        <h1 className="mr-1 text-[13px] font-semibold tracking-wide text-bone">
          Claude Code Board
        </h1>

        <div className="flex items-center gap-2 text-[11px] text-ash">
          {TALLY.filter((s) => p.counts[s]).map((s) => (
            <span key={s} className="no-drag flex items-center gap-1">
              <span className={`size-1.5 rounded-full ${statusStyle(s).dot}`} />
              {p.counts[s]} {statusStyle(s).label}
            </span>
          ))}
          {p.headlessCount > 0 && (
            <button
              onClick={() => p.onHeadlessOnly(!p.headlessOnly)}
              title="Sessions started by `claude -p` — scripts and cron jobs"
              className={`no-drag flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5
                          transition-colors ${
                            p.headlessOnly
                              ? 'bg-ichor/20 text-ichor'
                              : 'text-ichor/70 hover:text-ichor'
                          }`}
            >
              ⚡ {p.headlessCount} headless
            </button>
          )}
          {p.staleCount > 0 && (
            <span
              className="no-drag flex items-center gap-1 text-bile"
              title="Sessions running an older Claude than the one installed. Restart them to pick it up."
            >
              ↻ {p.staleCount} to restart
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <input
            ref={p.searchRef}
            value={p.query}
            onChange={(e) => p.onQuery(e.target.value)}
            placeholder="filter title, path, uuid…   ⌃F"
            title="Ctrl+F to focus. Enter drops into the grid; arrows move; Enter opens the terminal."
            spellCheck={false}
            className="no-drag w-56 rounded border border-suture bg-slab px-2 py-1 text-[12px]
                       text-bone placeholder:text-ash/60 focus:border-mortis focus:outline-none"
          />

          <select
            value={p.sort}
            onChange={(e) => p.onSort(e.target.value as SortKey)}
            title="Sort order"
            className="no-drag cursor-pointer rounded border border-suture bg-slab px-2 py-1
                       text-[12px] text-bone focus:outline-none"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                sort: {s.label}
              </option>
            ))}
          </select>

          <label className="no-drag flex cursor-pointer items-center gap-1.5 text-[12px] text-ash">
            <input
              type="checkbox"
              checked={p.showFinished}
              onChange={(e) => p.onShowFinished(e.target.checked)}
              className="accent-mortis"
            />
            finished
          </label>

          <button
            onClick={p.onRefresh}
            title="Rescan now"
            className={`no-drag cursor-pointer rounded border border-suture bg-slab px-2 py-1
                        text-[12px] text-bone hover:border-mortis ${p.scanning ? 'opacity-50' : ''}`}
          >
            ↻
          </button>
          <button
            onClick={p.onSettings}
            title="Settings"
            className="no-drag cursor-pointer rounded border border-suture bg-slab px-2 py-1
                       text-[12px] text-bone hover:border-mortis"
          >
            ⚙
          </button>
        </div>
      </div>

      {p.checkedCount > 0 ? (
        <div className="no-drag flex flex-wrap items-center gap-2 border-t border-clot/30
                        bg-clot/10 px-4 py-2">
          <span className="text-[12px] text-artery">{p.checkedCount} selected</span>
          <button
            onClick={p.onDeleteChecked}
            className="cursor-pointer rounded border border-clot bg-clot/20 px-2.5 py-1
                       text-[11px] text-artery hover:bg-clot/35"
          >
            Delete selected…
          </button>
          <button
            onClick={p.onSelectAllShown}
            className="cursor-pointer rounded border border-suture bg-slab px-2.5 py-1
                       text-[11px] text-bone hover:border-mortis"
          >
            Select all {p.shown} shown
          </button>
          <button
            onClick={p.onClearChecked}
            className="cursor-pointer rounded border border-suture bg-slab px-2.5 py-1
                       text-[11px] text-ash hover:text-bone"
          >
            Clear
          </button>
          <span className="ml-auto text-[11px] text-ash">
            nothing is deleted until you copy and run the script
          </span>
        </div>
      ) : null}

      {p.projects.length > 1 && (
        <div className="no-drag flex flex-wrap items-center gap-1.5 px-4 pb-2">
          {['all', ...p.projects].map((proj) => (
            <button
              key={proj}
              onClick={() => p.onProject(proj)}
              className={`cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[10px]
                          transition-colors ${
                            p.activeProject === proj
                              ? 'border-mortis bg-suture text-bone'
                              : 'border-suture bg-slab text-ash hover:text-bone'
                          }`}
            >
              {proj}
            </button>
          ))}
          <button
            onClick={p.onSelectAllShown}
            className="ml-auto cursor-pointer text-[11px] text-ash hover:text-bone"
            title="Tick every card currently shown"
          >
            select {p.shown} of {p.total}
          </button>
        </div>
      )}
    </header>
  )
}
