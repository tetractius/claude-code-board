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
