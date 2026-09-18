import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import type { BoardConfig } from '../../core/types.ts'

interface Props {
  config: BoardConfig
  onSave: (patch: Partial<BoardConfig>) => void
  onClose: () => void
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="text-[12px] text-bone">{label}</span>
      {hint && <span className="mt-0.5 block text-[11px] text-ash">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  )
}

const input =
  'w-full rounded border border-suture bg-slab px-2 py-1.5 font-mono text-[12px] text-bone ' +
  'placeholder:text-ash/60 focus:border-mortis focus:outline-none'

export default function SettingsModal({ config, onSave, onClose }: Props) {
  const [draft, setDraft] = useState<BoardConfig>(config)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-lg border border-suture bg-crypt shadow-2xl"
      >
        <header className="border-b border-suture px-4 py-3">
          <h2 className="text-sm font-medium text-bone">Settings</h2>
        </header>

        <div className="space-y-4 px-4 py-4">
          <Field
            label="Claude binary"
            hint="Leave empty to auto-detect from PATH and the usual install locations."
          >
            <input
              className={input}
              value={draft.claudeBin}
              placeholder="auto-detect"
              onChange={(e) => setDraft({ ...draft, claudeBin: e.target.value })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Poll interval (ms)" hint="Safety net; file watching drives most updates.">
              <input
                className={input}
                type="number"
                min={1000}
                step={500}
                value={draft.pollIntervalMs}
                onChange={(e) => setDraft({ ...draft, pollIntervalMs: Number(e.target.value) })}
              />
            </Field>
            <Field label="Finished sessions" hint="How many to keep; 0 for all.">
              <input
                className={input}
                type="number"
                min={0}
                value={draft.finishedLimit}
                onChange={(e) => setDraft({ ...draft, finishedLimit: Number(e.target.value) })}
              />
            </Field>
          </div>

          {api.platform === 'linux' ? (
            <>
              <Field label="Terminal emulator" hint="Used by “Open in Terminal”.">
                <input
                  className={input}
                  value={draft.terminalExec}
                  onChange={(e) => setDraft({ ...draft, terminalExec: e.target.value })}
                />
              </Field>
              <Field label="Terminal arguments" hint="One per line. {cmd} is the command to run.">
                <textarea
                  className={`${input} h-20 resize-none`}
                  value={draft.terminalArgs.join('\n')}
                  onChange={(e) =>
                    setDraft({ ...draft, terminalArgs: e.target.value.split('\n') })
                  }
                />
              </Field>
            </>
          ) : (
            <p className="text-[11px] text-ash">
              “Open in Terminal” uses iTerm when it is installed, and Terminal.app otherwise.
            </p>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-suture px-4 py-3">
          <button
            onClick={onClose}
            className="cursor-pointer rounded border border-suture bg-slab px-3 py-1.5 text-xs
                       text-ash hover:text-bone"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(draft)
              onClose()
            }}
            className="cursor-pointer rounded border border-verdigris/60 bg-verdigris/15 px-3 py-1.5
                       text-xs text-verdigris hover:bg-verdigris/25"
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
