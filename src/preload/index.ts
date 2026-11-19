import { contextBridge, ipcRenderer } from 'electron'
import { homedir } from 'node:os'
import { CHANNELS } from '../main/ipc.ts'
import type { BoardConfig, BoardSession, NoteMap, Note, ScanResult } from '../core/types.ts'
import type { DeletePanel } from '../core/commands.ts'
import type { HostTest } from '../main/hosts.ts'

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
  /** `host` is set for a session on a remote host, where the stop then runs. */
  stopSession: (pid: number, tty: string | null, host?: string): Promise<boolean> =>
    ipcRenderer.invoke(CHANNELS.stopSession, pid, tty, host),

  /** The host being shown; '' is this machine. */
  activeHost: (): Promise<string> => ipcRenderer.invoke(CHANNELS.hostGet),
  setHost: (host: string): Promise<string> => ipcRenderer.invoke(CHANNELS.hostSet, host),
  /** Connect to a host once and say what is there; a host must pass it to be added. */
  testHost: (host: string): Promise<HostTest> => ipcRenderer.invoke(CHANNELS.hostTest, host),
  /** Install the board's own Node on a host that has none. */
  installNode: (host: string): Promise<string> => ipcRenderer.invoke(CHANNELS.hostInstallNode, host),
  /** Best effort; resolves '' when no local terminal is connected to it. */
  focusRemote: (s: BoardSession): Promise<string> => ipcRenderer.invoke(CHANNELS.focusRemote, s),
  /** A new terminal window: ssh to the session's host and resume it there. */
  openRemote: (s: BoardSession): Promise<string> => ipcRenderer.invoke(CHANNELS.openRemote, s),

  hooksInstalled: (): Promise<boolean> => ipcRenderer.invoke(CHANNELS.hooksStatus),
  installHooks: (): Promise<void> => ipcRenderer.invoke(CHANNELS.hooksInstall),
  uninstallHooks: (): Promise<void> => ipcRenderer.invoke(CHANNELS.hooksUninstall),

  platform: process.platform,
  /** So the renderer can collapse paths to `~` without touching node. */
  home: homedir(),
}

export type BoardApi = typeof api

contextBridge.exposeInMainWorld('board', api)
