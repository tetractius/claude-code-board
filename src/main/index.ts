import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../core/scanner.ts'
import { loadNotes, setNote, flushNotes } from '../core/notes.ts'
import { loadConfig, saveConfig } from '../core/config.ts'
import {
  buildResumeCommand,
  buildRemoteResumeCommand,
  buildDeletePanel,
  buildBulkDeletePanel,
} from '../core/commands.ts'
import { focusRemoteSession } from '../core/sshTerminal.ts'
import { openInTerminal, focusTty } from '../core/terminal.ts'
import { stopSession } from '../core/stop.ts'
import { resetClaudeBin } from '../core/claudeCli.ts'
import {
  attentionSummary,
  newlyFinished,
  settleFinished,
  type PendingFinishes,
  newlyNeedingAttention,
  snapshot,
  type StatusSnapshot,
} from '../core/attention.ts'
import { hooksInstalled, installHooks, uninstallHooks } from '../core/hooks.ts'
import { NEEDS_ATTENTION, type BoardConfig, type BoardSession, type ScanResult } from '../core/types.ts'
import { CHANNELS } from './ipc.ts'
import { watchClaudeState } from './watcher.ts'
import {
  activeHost,
  closeAll,
  remoteClaudeBin,
  scanHost,
  setActiveHost,
  stopRemote,
  testHost,
  installRemoteNode,
} from './hosts.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Must run before `ready`. In a packaged build the name also comes from the
 * bundle, but this is what fixes the menu bar and the app switcher when
 * running from source, where the host binary is Electron's own.
 */
app.setName('Claude Code Board')

/** Bundled next to the built output in production, at the repo root in dev. */
const ICON_PNG = app.isPackaged
  ? join(process.resourcesPath, 'icon.png')
  : join(__dirname, '../../build/icon.png')

let win: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null
let stopWatching: (() => void) | null = null
/** Guards against overlapping scans when watch events arrive in a burst. */
let scanning = false
let rescanQueued = false
/** Statuses at the last pushed scan, to notify on transitions only. */
let lastStatuses: StatusSnapshot | null = null
/** Finished sessions held until they have stayed idle; see `settleFinished`. */
const pendingFinishes: PendingFinishes = new Map()
/** Held until dismissed: a garbage-collected Notification drops its click handler. */
const shown = new Set<Notification>()

async function runScan(): Promise<ScanResult> {
  const config = await loadConfig()
  const host = activeHost()
  if (host) {
    return scanHost(host, {
      finishedLimit: config.finishedLimit,
      contextWindow: config.contextWindow,
    })
  }
  return scan({
    claudeBin: config.claudeBin,
    finishedLimit: config.finishedLimit,
    contextWindow: config.contextWindow,
  })
}

async function pushScan(): Promise<void> {
  if (scanning) {
    rescanQueued = true
    return
  }
  scanning = true
  try {
    const result = await runScan()
    // The host was switched while this scan ran: it is the old host's board,
    // so drop it and scan the one now being shown.
    if ((result.host ?? '') !== activeHost()) {
      rescanQueued = true
      return
    }
    win?.webContents.send(CHANNELS.sessionsPushed, result)
    await notifyAttention(result)
  } catch (err) {
    console.error('[board] scan failed:', err)
  } finally {
    scanning = false
    if (rescanQueued) {
      rescanQueued = false
      void pushScan()
    }
  }
}

function showBoard(): void {
  if (!win) createWindow()
  else {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/**
 * Clicking goes where the session is: its terminal when it has one, the board
 * otherwise - or when the terminal can no longer be found.
 */
function notify(s: BoardSession, body: string): void {
  // Name and what happened, nothing else: the path and the prompt are on the
  // card, one click away.
  // A remote session says where it is: the same title can be open on two machines.
  const n = new Notification({ title: s.host ? `${s.title} · ${s.host}` : s.title, body })
  shown.add(n)
  n.on('close', () => shown.delete(n))
  n.on('click', () => {
    shown.delete(n)
    if (s.host) {
      void focusRemoteSession(s).then((app) => app || showBoard())
    } else if (s.where.type === 'tty' && process.platform === 'darwin') {
      focusTty(s.where.label).catch(showBoard)
    } else {
      showBoard()
    }
  })
  n.show()
}

async function notifyAttention(result: ScanResult): Promise<void> {
  // A failed scan returns no sessions; diffing against it would announce every
  // waiting session again once the next scan succeeds.
  if (result.sessions.length === 0 && result.error) return

  // The Dock badge counts what is waiting on you right now, whatever the
  // notification settings - it is the glance that replaces opening the board.
  // It only shows on macOS, and on Linux under a Unity launcher: on GNOME and
  // KDE `setBadgeCount` does nothing and returns false. Nothing depends on it,
  // so there is no guard - the notifications still work there.
  app.setBadgeCount(result.sessions.filter((s) => NEEDS_ATTENTION.has(s.status)).length)

  const needing = newlyNeedingAttention(lastStatuses, result.sessions)
  const finished = settleFinished(
    pendingFinishes,
    newlyFinished(lastStatuses, result.sessions),
    result.sessions,
    Date.now(),
  )
  lastStatuses = snapshot(result.sessions)
  if (!Notification.isSupported()) return

  const config = await loadConfig()
  if (config.notify) for (const s of needing) notify(s, attentionSummary(s))
  if (config.notifyDone) {
    for (const s of finished) {
      notify(s, 'Finished')
    }
  }
}

/**
 * Statuses are diffed scan to scan to find what changed. Across a host switch
 * that diff is meaningless - every waiting session on the new host would be
 * announced as newly waiting - so it starts over.
 */
function resetAttention(): void {
  lastStatuses = null
  pendingFinishes.clear()
  app.setBadgeCount(0)
}

/** Show `host` ('' for this machine): an empty board saying so at once, then its scan. */
function switchHost(host: string, configured: readonly string[]): void {
  setActiveHost(host, configured)
  resetAttention()
  win?.webContents.send(CHANNELS.sessionsPushed, {
    sessions: [],
    scannedAt: 0,
    host: host || undefined,
  } satisfies ScanResult)
  void pushScan()
}

function resumeCommandFor(s: BoardSession): string {
  return s.host
    ? buildRemoteResumeCommand(s, s.host, remoteClaudeBin(s.host))
    : buildResumeCommand(s)
}

async function startPolling(): Promise<void> {
  const { pollIntervalMs } = await loadConfig()
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = setInterval(() => void pushScan(), Math.max(1000, pollIntervalMs))
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.scan, () => runScan())
  ipcMain.handle(CHANNELS.notesLoad, () => loadNotes())
  ipcMain.handle(CHANNELS.notesSet, (_e, sessionId: string, text: string, ctx) =>
    setNote(sessionId, text, ctx ?? {}),
  )
  ipcMain.handle(CHANNELS.configLoad, () => loadConfig())
  ipcMain.handle(CHANNELS.configSave, async (_e, patch: Partial<BoardConfig>) => {
    const next = await saveConfig(patch)
    // A changed binary path invalidates the cached lookup, and a changed
    // interval needs the timer rebuilt.
    resetClaudeBin()
    await startPolling()
    // The host being shown was just removed from Settings: back to this machine.
    if (activeHost() && !next.remoteHosts.includes(activeHost())) switchHost('', next.remoteHosts)
    else void pushScan()
    return next
  })
  ipcMain.handle(CHANNELS.hostGet, () => activeHost())
  ipcMain.handle(CHANNELS.hostSet, async (_e, host: string) => {
    switchHost(host, (await loadConfig()).remoteHosts)
    return activeHost()
  })
  ipcMain.handle(CHANNELS.hostTest, (_e, host: string) => testHost(host))
  ipcMain.handle(CHANNELS.hostInstallNode, async (_e, host: string) => {
    const summary = await installRemoteNode(host)
    if (host === activeHost()) void pushScan()
    return summary
  })
  ipcMain.handle(CHANNELS.focusRemote, (_e, session: BoardSession) => focusRemoteSession(session))
  ipcMain.handle(CHANNELS.openRemote, (_e, session: BoardSession) => {
    if (!session.host) throw new Error('Not a remote session.')
    return openInTerminal(resumeCommandFor(session))
  })
  ipcMain.handle(CHANNELS.resumeCommand, (_e, session: BoardSession) => resumeCommandFor(session))
  // A remote session's panel is wrapped to run on its host over ssh.
  ipcMain.handle(CHANNELS.deletePanel, (_e, session: BoardSession) => buildDeletePanel(session))
  ipcMain.handle(CHANNELS.bulkDeletePanel, (_e, sessions: BoardSession[]) =>
    buildBulkDeletePanel(sessions),
  )
  ipcMain.handle(CHANNELS.openTerminal, (_e, command: string) => openInTerminal(command))
  ipcMain.handle(CHANNELS.focusTty, (_e, tty: string) => focusTty(tty))
  ipcMain.handle(CHANNELS.hooksStatus, () => hooksInstalled())
  ipcMain.handle(CHANNELS.hooksInstall, async () => {
    await installHooks()
    void pushScan()
  })
  ipcMain.handle(CHANNELS.hooksUninstall, async () => {
    await uninstallHooks()
    void pushScan()
  })
  ipcMain.handle(CHANNELS.stopSession, async (_e, pid: number, tty: string | null, host?: string) => {
    if (!Number.isInteger(pid) || pid <= 1) throw new Error(`not a pid: ${pid}`)
    const stopped = host ? await stopRemote(host, pid, tty) : await stopSession(pid, tty)
    void pushScan()
    return stopped
  })
  ipcMain.handle(CHANNELS.openExternal, (_e, url: string) => {
    // Only ever hand http(s) links to the OS.
    if (!/^https?:\/\//i.test(url)) throw new Error('refusing to open a non-http url')
    return shell.openExternal(url)
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 420,
    minHeight: 400,
    show: false,
    backgroundColor: '#08080a',
    title: 'Claude Code Board',
    icon: ICON_PNG,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // ESM preload scripts require the sandbox to be off; context isolation
      // still keeps the renderer off Node.
      sandbox: false,
    },
  })

  // Without this, a crash in the renderer just shows an empty window and says
  // nothing at all on the terminal.
  win.webContents.on('console-message', (...args: unknown[]) => {
    const first = args[0] as { message?: string; level?: string; lineNumber?: number }
    const message = typeof first === 'object' && first?.message ? first.message : args[1]
    console.log(`[renderer] ${message}`)
  })
  win.webContents.on('did-fail-load', (_e, code, description) => {
    console.error(`[renderer] failed to load (${code}): ${description}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason)
  })

  win.once('ready-to-show', () => {
    win?.show()
    void pushScan()
  })

  win.on('closed', () => {
    win = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(async () => {
  // Running from source, the Dock would otherwise show Electron's own icon.
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock?.setIcon(ICON_PNG)
    } catch (err) {
      console.warn('[board] could not set dock icon:', (err as Error).message)
    }
  }

  registerIpc()
  createWindow()
  // Local files changing say nothing about a remote host, which is polled.
  stopWatching = watchClaudeState(() => {
    if (!activeHost()) void pushScan()
  })
  await startPolling()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async (event) => {
  if (pollTimer) clearInterval(pollTimer)
  stopWatching?.()
  stopWatching = null
  closeAll()
  // Make sure a note typed a moment ago is not lost to the write debounce.
  event.preventDefault()
  await flushNotes()
  app.exit(0)
})
