import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  label?: string
  className?: string
  title?: string
}

/** Copies `value` to the clipboard and confirms it in place for a moment. */
export default function CopyButton({ value, label = 'Copy', className = '', title }: Props) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }, [value])

  return (
    <button
      type="button"
      onClick={copy}
      title={title ?? `Copy: ${value}`}
      className={`no-drag cursor-pointer rounded border px-3 py-1.5 text-xs transition-colors ${
        copied
          ? 'border-verdigris/60 bg-verdigris/15 text-verdigris'
          : 'border-suture bg-slab text-bone hover:border-mortis hover:bg-suture'
      } ${className}`}
    >
      {copied ? '✓ copied' : label}
    </button>
  )
}
