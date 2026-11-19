import type { BoardApi } from '../../preload/index.ts'

declare global {
  interface Window {
    board: BoardApi
  }
}

/**
 * The single seam between the UI and its data source. Today it forwards to the
 * Electron preload bridge; serving the board from a remote host means replacing
 * the body of this module with fetch + EventSource and changing nothing else.
 */
export const api: BoardApi = window.board

export const HOME = api.home

/** Electron prefixes errors thrown in the main process; the UI only needs the message. */
export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*': Error: /, '')
}
