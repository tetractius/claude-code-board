import { useEffect, useState } from 'react'

/**
 * Ending a session is a click you cannot take back, so the first click only
 * arms the button and a second one within a few seconds confirms.
 */
export default function StopButton({
  suspended,
  onStop,
}: {
  suspended: boolean
  onStop: () => Promise<void>
}) {
  const [armed, setArmed] = useState(false)
  const [stopping, setStopping] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <button
      onClick={() => {
        if (!armed) return setArmed(true)
        setArmed(false)
        setStopping(true)
        void onStop().finally(() => setStopping(false))
      }}
      disabled={stopping}
      title={
        armed
          ? 'Click again to stop. The conversation is kept and can be resumed.'
          : suspended
            ? 'Force-stop this session: it is suspended, so it cannot shut down by itself. The conversation is kept and can be resumed.'
            : 'End this Claude session. The conversation is kept and can be resumed.'
      }
      className={`cursor-pointer rounded border px-2.5 py-1 text-[11px] ${
        armed
          ? 'border-artery bg-artery/40 text-bone'
          : 'border-suture bg-slab text-ash hover:border-clot hover:bg-clot/15 hover:text-artery'
      } disabled:cursor-wait disabled:text-ash/50`}
    >
      {stopping ? 'Stopping…' : armed ? 'Confirm stop' : 'Stop'}
    </button>
  )
}
