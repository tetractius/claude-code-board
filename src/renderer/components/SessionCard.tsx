import { memo } from 'react'
import StatusBadge from './StatusBadge.tsx'
import NotesPanel from './NotesPanel.tsx'
import { api } from '../lib/api.ts'
import {
  ACTIVITY_SOURCE_HINT,
  formatTokens,
  relativeTime,
  shortId,
  statusStyle,
  tildify,
} from '../lib/format.ts'
import { TERMINAL_STATUS, type BoardSession } from '../../core/types.ts'

interface Props {
  session: BoardSession
  noteText: string
  selected: boolean
  /** Ticked for bulk delete - independent of the keyboard selection. */
  checked: boolean
  onToggleChecked: (key: string) => void
  /** Set when a focus attempt for this card failed, so it can say why. */
  focusError?: string
  onNoteSaved: (sessionId: string, text: string) => void
  onResume: (s: BoardSession) => void
  onDelete: (s: BoardSession) => void
  onSelect: (key: string) => void
  onFocusTty: (s: BoardSession) => void
}

/** Whether this session can be jumped to - macOS, and running in a terminal. */
export function canFocusTty(s: BoardSession): boolean {
  return s.where.type === 'tty' && api.platform === 'darwin'
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded border border-suture bg-slab px-1.5 py-0.5 font-mono text-[10px] text-ash"
    >
      {children}
    </span>
  )
}

function SessionCard({
  session: s,
  noteText,
  selected,
  checked,
  onToggleChecked,
  focusError,
  onNoteSaved,
  onResume,
  onDelete,
  onSelect,
  onFocusTty,
}: Props) {
  const dead = TERMINAL_STATUS.has(s.status)
  const canFocus = canFocusTty(s)
  const annotated = noteText.trim().length > 0
  const style = statusStyle(s.status)

  return (
    <article
      data-card={s.key}
      onMouseDown={() => onSelect(s.key)}
      className={`relative flex flex-col gap-2.5 overflow-hidden rounded-lg border bg-crypt
                  p-3 pl-4 transition-colors ${
                    selected ? 'outline-2 outline-offset-1 outline-bone/45' : ''
                  } ${
                    s.status === 'waiting' || s.status === 'blocked'
                      ? 'border-artery/50'
                      : 'border-suture hover:border-mortis'
                  } ${dead ? 'opacity-65 hover:opacity-100' : ''}`}
    >
      {/*
        A painted bar rather than border-left: the hover state restyles the
        border on all four sides, which would silently wipe out a left-edge
        accent built from border utilities.
      */}
      <span className={`absolute inset-y-0 left-0 w-[5px] ${style.dot}`} aria-hidden />
      <header className="flex items-center justify-between gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggleChecked(s.key)}
          onClick={(e) => e.stopPropagation()}
          title="Select for bulk delete"
          className="size-3 shrink-0 cursor-pointer accent-artery"
        />
        <StatusBadge
          status={s.status}
          waitingFor={s.waitingFor}
          hint={
            s.status === 'unknown'
              ? `${s.where.label} does not publish session status — only terminal ` +
                'sessions send heartbeats, so the board cannot tell idle from busy here.'
              : undefined
          }
        />
        <span
          className="shrink-0 text-[11px] text-ash"
          title={ACTIVITY_SOURCE_HINT[s.lastActivitySource]}
        >
          {relativeTime(s.lastActivity)}
          {s.lastActivitySource === 'mtime' && '*'}
        </span>
      </header>

      <div className="min-w-0">
        <h2 className="truncate text-[14px] font-medium text-bone" title={s.title}>
          {s.title}
        </h2>
        <p className="truncate font-mono text-[11px] text-ash" title={s.cwd}>
          {tildify(s.cwd)}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {canFocus ? (
          <button
            onClick={() => onFocusTty(s)}
            title={`Bring the ${s.where.label} window to the front`}
            className="cursor-pointer rounded border border-suture bg-slab px-1.5 py-0.5
                       font-mono text-[10px] text-ash transition-colors hover:border-verdigris/60
                       hover:bg-verdigris/10 hover:text-bone"
          >
            ↗ {s.where.label}
          </button>
        ) : (
          <Chip
            title={
              s.where.type === 'host'
                ? `Running inside ${s.where.label}, not a terminal`
                : s.where.type
            }
          >
            {s.where.label}
          </Chip>
        )}
        {s.kind === 'background' && <Chip title="Started with --bg">bg</Chip>}
        {/*
          A `claude -p` run: started by a script or a cron job, printed its
          answer and exited. Claude marks these `entrypoint: "sdk-cli"`.
        */}
        {s.headless && (
          <span
            title={
              `Headless run (claude -p)${s.command ? `, started with ${s.command}` : ''} — ` +
              'a script or scheduled job, not something you opened'
            }
            className="rounded border border-ichor/50 bg-ichor/10 px-1.5 py-0.5 font-mono
                       text-[10px] text-ichor"
          >
            ⚡ -p{s.command ? ` ${s.command}` : ''}
          </span>
        )}
        {/*
          The job's run has finished but you are attached and prompting it
          again, so the badge shows your live status - this keeps the run's
          outcome visible rather than silently dropping it.
        */}
        {s.jobState && TERMINAL_STATUS.has(s.jobState as never) && !dead && (
          <span
            title={`The background job's last run ended "${s.jobState}"; the session is still open`}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
              s.jobState === 'failed'
                ? 'border-clot/60 bg-clot/10 text-artery'
                : 'border-mortis bg-slab text-ash'
            }`}
          >
            job {s.jobState}
          </span>
        )}
        {s.isFork && (
          <Chip title={s.forkParentSessionId ? `Forked from ${s.forkParentSessionId}` : 'Forked'}>
            ⑂ fork
          </Chip>
        )}
        {s.pid && <Chip title="Process id">pid {s.pid}</Chip>}
        {s.needsRestart && (
          <span
            title={`Running ${s.version}, but a newer Claude is installed. This session keeps the old build until you restart it.`}
            className="rounded border border-bile/50 bg-bile/10 px-1.5 py-0.5 font-mono
                       text-[10px] text-bile"
          >
            ↻ restart to update
          </span>
        )}
        {s.tokens !== undefined && <Chip title="Tokens used">{formatTokens(s.tokens)} tok</Chip>}
      </div>

      {focusError && <p className="text-[11px] text-artery">{focusError}</p>}

      {s.detail && <p className="line-clamp-2 text-[12px] text-ash italic">{s.detail}</p>}

      {s.needs && (
        <div className="rounded border border-artery/40 bg-artery/10 px-2 py-1.5">
          <div className="mb-0.5 text-[10px] tracking-wider text-artery uppercase">needs you</div>
          <p className="text-[12px] leading-snug text-bone">{s.needs}</p>
        </div>
      )}

      {s.children && s.children.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {s.children.map((c) => (
            <button
              key={c.href}
              onClick={() => void api.openExternal(c.href)}
              title={c.href}
              className="cursor-pointer text-[11px] text-verdigris hover:underline"
            >
              ↗ {c.kind} #{c.id}
            </button>
          ))}
        </div>
      )}

      <NotesPanel
        sessionId={s.sessionId}
        initialText={noteText}
        cwd={s.cwd}
        title={s.title}
        annotated={annotated}
        selected={selected}
        onSaved={onNoteSaved}
      />

      <footer className="flex items-center justify-between gap-2 border-t border-suture pt-2">
        <button
          onClick={() => void navigator.clipboard.writeText(s.sessionId)}
          title={`${s.sessionId}\n(click to copy)`}
          className="cursor-pointer truncate font-mono text-[10px] text-ash hover:text-bone"
        >
          {shortId(s.sessionId)}… ⧉
        </button>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => onResume(s)}
            className="cursor-pointer rounded border border-suture bg-slab px-2.5 py-1 text-[11px]
                       text-bone hover:border-verdigris/60 hover:bg-verdigris/10"
          >
            Resume
          </button>
          <button
            onClick={() => onDelete(s)}
            className="cursor-pointer rounded border border-suture bg-slab px-2.5 py-1 text-[11px]
                       text-ash hover:border-clot hover:bg-clot/15 hover:text-artery"
          >
            Delete
          </button>
        </div>
      </footer>
    </article>
  )
}

/**
 * Memoised on the fields the card actually renders. Without this, every scan
 * push (about one a second) re-renders every card in the grid, which is what
 * makes typing in a note drop characters.
 */
export default memo(SessionCard, (a, b) => {
  const x = a.session
  const y = b.session
  return (
    a.noteText === b.noteText &&
    a.selected === b.selected &&
    a.checked === b.checked &&
    a.focusError === b.focusError &&
    x.key === y.key &&
    x.status === y.status &&
    x.waitingFor === y.waitingFor &&
    x.title === y.title &&
    x.cwd === y.cwd &&
    x.lastActivity === y.lastActivity &&
    x.detail === y.detail &&
    x.needs === y.needs &&
    x.tokens === y.tokens &&
    x.pid === y.pid &&
    x.where.label === y.where.label &&
    x.isFork === y.isFork &&
    x.children === y.children &&
    x.needsRestart === y.needsRestart &&
    x.jobState === y.jobState &&
    x.headless === y.headless &&
    x.command === y.command
  )
})
