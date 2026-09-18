import { useEffect, useState } from 'react'
import CopyButton from './CopyButton.tsx'
import { api } from '../lib/api.ts'

export type ModalKind = 'resume' | 'delete'

export interface CommandBlock {
  title: string
  note?: string
  command: string
}

interface Props {
  kind: ModalKind
  title: string
  /** One panel per option, each copied independently. */
  blocks: CommandBlock[]
  /** Shown once above the blocks. */
  warnings?: string[]
  onClose: () => void
}

/**
 * Shows copyable shell commands. The delete variant is presentational only -
 * the board never removes anything itself, because there is no `claude`
 * subcommand for it and the guards that make deletion safe live in the CLI's
 * own TUI.
 *
 * Each block carries its own copy button so the options can be taken one at a
 * time; that is also why every block repeats its variable declarations rather
 * than sharing them.
 */
export default function CommandModal({ kind, title, blocks, warnings = [], onClose }: Props) {
  const danger = kind === 'delete'
  const [launch, setLaunch] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const openTerminal = async () => {
    try {
      const app = await api.openTerminal(blocks[0].command)
      setLaunch({ ok: true, text: `opened in ${app}` })
    } catch (err) {
      setLaunch({ ok: false, text: (err as Error).message })
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border
                    bg-crypt shadow-2xl ${danger ? 'border-clot/70' : 'border-suture'}`}
      >
        <header
          className={`flex shrink-0 items-center justify-between border-b px-4 py-3 ${
            danger ? 'border-clot/40 bg-clot/10' : 'border-suture'
          }`}
        >
          <h2 className={`text-sm font-medium ${danger ? 'text-artery' : 'text-bone'}`}>
            {danger ? '⚠ ' : ''}
            {title}
          </h2>
          <button
            onClick={onClose}
            className="cursor-pointer px-1 text-ash hover:text-bone"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {danger && (
            <p className="border-b border-suture px-4 py-2 text-[12px] text-ash">
              Nothing here runs automatically. Copy whichever you want and run it yourself.
            </p>
          )}

          {warnings.map((w) => (
            <p
              key={w}
              className="border-b border-bile/30 bg-bile/5 px-4 py-2 text-[12px] text-bile"
            >
              ⚠ {w}
            </p>
          ))}

          <div className="space-y-3 p-4">
            {blocks.map((block) => (
              <section key={block.title} className="rounded border border-suture bg-slab/40">
                <header className="flex items-center justify-between gap-3 border-b border-suture px-3 py-2">
                  <div className="min-w-0">
                    <h3 className="text-[12px] font-medium text-bone">{block.title}</h3>
                    {block.note && (
                      <p className="mt-0.5 text-[11px] leading-snug text-ash">{block.note}</p>
                    )}
                  </div>
                  <CopyButton value={block.command} label="Copy" className="shrink-0" />
                </header>
                <pre className="overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-bone">
                  {block.command}
                </pre>
              </section>
            ))}
          </div>
        </div>

        {kind === 'resume' && (
          <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-suture px-4 py-3">
            <span className={`text-[11px] ${launch?.ok === false ? 'text-artery' : 'text-ash'}`}>
              {launch?.text ?? ''}
            </span>
            <button
              type="button"
              onClick={openTerminal}
              className="cursor-pointer rounded border border-suture bg-slab px-3 py-1.5 text-xs
                         text-bone hover:border-mortis hover:bg-suture"
            >
              Open in Terminal
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}
