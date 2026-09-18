import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import { CHANNELS } from '../main/ipc.ts'
import type { BoardConfig, BoardSession, NoteMap, Note, ScanResult } from '../core/types.ts'
import type { DeletePanel } from '../core/commands.ts'

/**
 * The renderer's entire view of the outside world. Keeping it this small is
 * what lets `src/renderer/lib/api.ts` swap this for HTTP + SSE when the board
 * is served from a remote host.
 */
const api = {
  scan: (): Promise<ScanResult> => ipcRenderer.invoke(CHANNELS.scan),

  onSessions: (cb: (result: ScanResult) => void): (() => void) => {
    const handler = (_e: unknown, result: ScanResult) => cb(result)
    ipcRenderer.on(CHANNELS.sessionsPushed, handler)
    return () => ipcRenderer.off(CHANNELS.sessionsPushed, handler)
  },

  loadNotes: (): Promise<NoteMap> => ipcRenderer.invoke(CHANNELS.notesLoad),
  setNote: (
    sessionId: string,
    text: string,
    ctx?: { cwd?: string; title?: string },
  ): Promise<Note | null> => ipcRenderer.invoke(CHANNELS.notesSet, sessionId, text, ctx),

  loadConfig: (): Promise<BoardConfig> => ipcRenderer.invoke(CHANNELS.configLoad),
  saveConfig: (patch: Partial<BoardConfig>): Promise<BoardConfig> =>
    ipcRenderer.invoke(CHANNELS.configSave, patch),

  resumeCommand: (s: BoardSession): Promise<string> =>
    ipcRenderer.invoke(CHANNELS.resumeCommand, s),
  deletePanel: (s: BoardSession): Promise<DeletePanel> =>
    ipcRenderer.invoke(CHANNELS.deletePanel, s),
  bulkDeletePanel: (sessions: BoardSession[]): Promise<DeletePanel> =>
    ipcRenderer.invoke(CHANNELS.bulkDeletePanel, sessions),
  openTerminal: (command: string): Promise<string> =>
    ipcRenderer.invoke(CHANNELS.openTerminal, command),
  focusTty: (tty: string): Promise<string> => ipcRenderer.invoke(CHANNELS.focusTty, tty),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke(CHANNELS.openExternal, url),

  platform: process.platform,
  /** So the renderer can collapse paths to `~` without touching node. */
  home: homedir(),
}

export type BoardApi = typeof api

contextBridge.exposeInMainWorld('board', api)
