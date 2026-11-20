import { useEffect, useRef, useState } from 'react'
import { hostColor, tint } from '../lib/hosts.ts'

interface Props {
  /** The host being shown; '' is this machine. */
  host: string
  hosts: readonly string[]
  onHost: (host: string) => void
  onManage: () => void
}

const LOCAL = 'localhost'

/**
 * Which machine the board shows. A custom menu rather than a <select>: the
 * native popup on macOS ignores per-option colours, and the colour is the
 * point - each host is told apart by it, this machine by having none.
 */
export default function HostMenu({ host, hosts, onHost, onManage }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const color = hostColor(host, hosts)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (h: string) => {
    setOpen(false)
    if (h !== host) onHost(h)
  }

  return (
    <div ref={ref} className="no-drag relative">
      <button
        onClick={() => setOpen(!open)}
        title={
          host
            ? `Showing ${host}, over SSH. Choose another machine.`
            : 'Showing this machine. Choose a remote host (Settings → Remote hosts).'
        }
        style={color ? { color, borderColor: tint(color, 0.6), background: tint(color, 0.12) } : {}}
        className="flex cursor-pointer items-center gap-1.5 rounded border border-suture bg-slab
                   px-2 py-1 font-mono text-[12px] text-bone focus:outline-none"
      >
        {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
        {host || LOCAL}
        <span className="text-[9px] opacity-70">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 max-h-[70vh] min-w-44 overflow-y-auto rounded
                     border border-suture bg-crypt py-1 shadow-2xl"
        >
          {['', ...hosts].map((h) => {
            const c = hostColor(h, hosts)
            return (
              <button
                key={h || LOCAL}
                role="menuitemradio"
                aria-checked={h === host}
                onClick={() => choose(h)}
                style={c ? { color: c } : {}}
                className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left
                            font-mono text-[12px] hover:bg-slab ${c ? '' : 'text-bone'}`}
              >
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: c ?? 'transparent' }}
                />
                <span className="flex-1">{h || LOCAL}</span>
                {h === host && <span className="text-ash">✓</span>}
              </button>
            )
          })}
          <div className="my-1 border-t border-suture" />
          <button
            onClick={() => {
              setOpen(false)
              onManage()
            }}
            className="w-full cursor-pointer px-3 py-1.5 text-left text-[11px] text-ash
                       hover:bg-slab hover:text-bone"
          >
            {hosts.length ? 'Manage hosts…' : 'Add a remote host…'}
          </button>
        </div>
      )}
    </div>
  )
}
