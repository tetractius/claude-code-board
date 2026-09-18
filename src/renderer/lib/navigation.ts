/**
 * How many columns the board is currently showing.
 *
 * The grid uses `repeat(auto-fill, ...)`, so the count changes with the window
 * and is only knowable after layout - the resolved `grid-template-columns` is
 * a list of pixel tracks, one per column.
 */
export function columnCount(grid: HTMLElement | null): number {
  if (!grid) return 1
  const tracks = getComputedStyle(grid).gridTemplateColumns
  if (!tracks || tracks === 'none') return 1
  return Math.max(1, tracks.split(' ').filter(Boolean).length)
}

export type Direction = 'left' | 'right' | 'up' | 'down'

/**
 * Move `index` one step in `direction` across a grid of `total` items laid out
 * in `cols` columns, clamped at the edges so navigation never wraps to a card
 * on the far side of the board.
 */
export function step(index: number, direction: Direction, cols: number, total: number): number {
  if (total === 0) return -1
  const delta = { left: -1, right: 1, up: -cols, down: cols }[direction]
  const next = index + delta
  return next < 0 || next >= total ? index : next
}

/** True when the event came from somewhere the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || !!el?.isContentEditable
}
