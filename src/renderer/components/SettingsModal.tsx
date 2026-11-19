import { useEffect, useState } from 'react'
import { api, errorMessage } from '../lib/api.ts'
import { hostColor } from '../lib/hosts.ts'
import { isValidHost } from '../../core/hostname.ts'
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

/**
 * Installing edits the user's own `~/.claude/settings.json`, so it is a button
 * with the consequences spelled out, never something the board does by itself.
 */
function HooksSection() {
  const [installed, setInstalled] = useState<boolean | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.hooksInstalled().then(setInstalled, () => setInstalled(false))
  }, [])

  const run = async (action: () => Promise<void>) => {
    setError('')
    try {
      await action()
      setInstalled(await api.hooksInstalled())
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="rounded border border-suture px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-bone">Status hooks</span>
        {installed !== null && (
          <button
            onClick={() => void run(installed ? api.uninstallHooks : api.installHooks)}
            className="cursor-pointer rounded border border-suture bg-slab px-2.5 py-1 text-[11px]
                       text-bone hover:border-verdigris/60 hover:bg-verdigris/10"
          >
            {installed ? 'Remove' : 'Install'}
          </button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-ash">
        Adds a hook to ~/.claude/settings.json that records each session's busy / waiting / idle
        state in ~/.claude-board/hooks. More reliable than reading Claude's internal files, which
        change between versions. Stores no prompt text. Running sessions pick it up from their
        next message; a backup is kept as settings.json.board-backup.
      </p>
      <p className="mt-1 text-[11px] text-ash">
        That file is global, so the hook runs for every Claude Code session on this machine - in
        any project, with or without the board open - not only the ones shown here. Remote hosts
        are not changed.
      </p>
      {error && <p className="mt-1 text-[11px] text-artery">{error}</p>}
    </div>
  )
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        className="mt-0.5 accent-verdigris"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="text-[12px] text-bone">{label}</span>
        <span className="mt-0.5 block text-[11px] text-ash">{hint}</span>
      </span>
    </label>
  )
}

const code =
  'mt-1 overflow-x-auto rounded border border-suture bg-void px-2 py-1.5 font-mono text-[11px] ' +
  'leading-relaxed text-bone whitespace-pre'

/**
 * The machines the host menu in the title bar can switch to. Only a host name
 * is stored, so this says plainly where everything else goes, and how to set
 * up the key login the board relies on - it never asks for a password.
 */
function RemoteHostsSection({
  hosts,
  onChange,
}: {
  hosts: string[]
  onChange: (hosts: string[]) => void
}) {
  const [name, setName] = useState('')
  const [tests, setTests] = useState<Record<string, { ok?: boolean; text: string }>>({})
  const typed = name.trim()
  const problem = !typed
    ? ''
    : !isValidHost(typed)
      ? 'A host name only: no user@, no :port, no spaces. Those go in ~/.ssh/config.'
      : hosts.includes(typed)
        ? 'Already in the list.'
        : ''
  const example = (typed && !problem ? typed : hosts[0]) || 'devbox'

  const add = () => {
    if (!typed || problem) return
    onChange([...hosts, typed])
    setName('')
  }

  const test = async (h: string) => {
    setTests((t) => ({ ...t, [h]: { text: 'Connecting…' } }))
    try {
      const text = await api.testHost(h)
      setTests((t) => ({ ...t, [h]: { ok: true, text } }))
    } catch (err) {
      setTests((t) => ({ ...t, [h]: { ok: false, text: errorMessage(err) } }))
    }
  }

  return (
    <div className="rounded border border-suture px-3 py-2.5">
      <span className="text-[12px] text-bone">Remote hosts (SSH)</span>
      <p className="mt-1 text-[11px] text-ash">
        Each host is added to the menu next to “sort” in the title bar, in its own colour. Pick
        one there to see that machine's sessions instead of this one's.
      </p>
      <p className="mt-1 text-[11px] text-bone">
        Only the host name is stored - exactly what you would type after <code>ssh</code>. User,
        port, key file and jump hosts come from your <code>~/.ssh/config</code>, as they would for
        any ssh.
      </p>

      {hosts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {hosts.map((h) => {
            const t = tests[h]
            return (
              <li key={h}>
                <div className="flex items-center gap-2">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: hostColor(h, hosts) }}
                  />
                  <span className="flex-1 font-mono text-[12px]" style={{ color: hostColor(h, hosts) }}>
                    {h}
                  </span>
                  <button
                    onClick={() => void test(h)}
                    className="cursor-pointer rounded border border-suture bg-slab px-2 py-0.5 text-[11px]
                               text-bone hover:border-mortis"
                  >
                    Test
                  </button>
                  <button
                    onClick={() => onChange(hosts.filter((x) => x !== h))}
                    title={`Remove ${h}`}
                    className="cursor-pointer rounded border border-suture bg-slab px-2 py-0.5 text-[11px]
                               text-ash hover:border-clot hover:text-artery"
                  >
                    Remove
                  </button>
                </div>
                {t && (
                  <p
                    className={`ml-4 mt-0.5 text-[11px] ${
                      t.ok === undefined ? 'text-ash' : t.ok ? 'text-verdigris' : 'text-artery'
                    }`}
                  >
                    {t.text}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <div className="mt-2 flex gap-2">
        <input
          className={input}
          value={name}
          placeholder="host name, e.g. devbox"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          onClick={add}
          disabled={!typed || !!problem}
          className="cursor-pointer rounded border border-suture bg-slab px-3 text-[11px] text-bone
                     hover:border-mortis disabled:cursor-not-allowed disabled:text-ash/50"
        >
          Add
        </button>
      </div>
      {problem && <p className="mt-1 text-[11px] text-artery">{problem}</p>}

      <p className="mt-3 text-[11px] text-ash">
        The board connects without ever asking for a password, so set up key login first, once per
        host:
      </p>
      <pre className={code}>{`ssh-keygen -t ed25519    # only if you have no key yet
ssh-copy-id ${example}${' '.repeat(Math.max(1, 13 - example.length))}# copies your public key there
ssh ${example} true${' '.repeat(Math.max(1, 16 - example.length))}# must work without a password prompt`}</pre>
      <p className="mt-2 text-[11px] text-ash">
        A different user or port? Say so in <code>~/.ssh/config</code>, and keep the short name here:
      </p>
      <pre className={code}>{`Host ${example}
  HostName ${example}.example.com
  User me
  Port 2222`}</pre>
      <p className="mt-2 text-[11px] text-ash">
        The host needs Node.js 18 or newer: the board copies its scanner to{' '}
        <code>~/.claude-board/remote</code> there and runs it over the connection. On a remote
        host, Open reconnects over ssh and resumes the session; deleting is not available.
      </p>
    </div>
  )
}

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
        className="flex max-h-full w-full max-w-lg flex-col rounded-lg border border-suture bg-crypt
                   shadow-2xl"
      >
        <header className="border-b border-suture px-4 py-3">
          <h2 className="text-sm font-medium text-bone">Settings</h2>
        </header>

        <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
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

          <Toggle
            label="Notify when a session needs you"
            hint="When a session starts waiting or becomes blocked. Click it to jump to the session's terminal."
            checked={draft.notify}
            onChange={(notify) => setDraft({ ...draft, notify })}
          />
          <Toggle
            label="Notify when a session finishes"
            hint="When a busy session ends its turn and goes idle."
            checked={draft.notifyDone}
            onChange={(notifyDone) => setDraft({ ...draft, notifyDone })}
          />

          <HooksSection />

          <RemoteHostsSection
            hosts={draft.remoteHosts}
            onChange={(remoteHosts) => setDraft({ ...draft, remoteHosts })}
          />

          <Field
            label="Context window (tokens)"
            hint="For the ctx % on each card. A session past it is measured against 1M."
          >
            <input
              className={input}
              type="number"
              min={1000}
              step={1000}
              value={draft.contextWindow}
              onChange={(e) => setDraft({ ...draft, contextWindow: Number(e.target.value) })}
            />
          </Field>

          <Field label="Dormant after (hours)" hint="An open session idle this long counts as dormant.">
            <input
              className={input}
              type="number"
              min={1}
              value={draft.dormantHours}
              onChange={(e) => setDraft({ ...draft, dormantHours: Number(e.target.value) })}
            />
          </Field>

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
