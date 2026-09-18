import { watch, type FSWatcher } from 'node:fs'
import { JOBS_DIR, REGISTRY_DIR } from '../core/paths.ts'

/**
 * Watch the two directories Claude writes to on every state change:
 * `~/.claude/sessions/<pid>.json` is rewritten on each status transition, and
 * `~/.claude/jobs/<id>/state.json` on each background job update. This is what
 * makes the board feel live; the interval poll in main is only a safety net,
 * because fs.watch on macOS is not reliable across directories.
 */
export function watchClaudeState(onChange: () => void, debounceMs = 300): () => void {
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | null = null

  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  for (const dir of [REGISTRY_DIR, JOBS_DIR]) {
    try {
      watchers.push(watch(dir, { recursive: true }, fire))
    } catch (err) {
      console.warn(`[board] cannot watch ${dir}:`, (err as Error).message)
    }
  }

  return () => {
    if (timer) clearTimeout(timer)
    for (const w of watchers) w.close()
  }
}
