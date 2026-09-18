import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scan } from '../core/scanner.ts'
import { loadNotes, setNote, flushNotes } from '../core/notes.ts'
import { loadConfig, saveConfig } from '../core/config.ts'
import {
  buildResumeCommand,
  buildDeletePanel,
  buildBulkDeletePanel,
} from '../core/commands.ts'
import { openInTerminal, focusTty } from '../core/terminal.ts'
import { resetClaudeBin } from '../core/claudeCli.ts'
import type { BoardConfig, ScanResult } from '../core/types.ts'
import { CHANNELS } from './ipc.ts'
import { watchClaudeState } from './watcher.ts'

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

async function runScan(): Promise<ScanResult> {
  const config = await loadConfig()
  return scan({ claudeBin: config.claudeBin, finishedLimit: config.finishedLimit })
}

async function pushScan(): Promise<void> {
  if (scanning) {
    rescanQueued = true
    return
  }
  scanning = true
  try {
    const result = await runScan()
    win?.webContents.send(CHANNELS.sessionsPushed, result)
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
    void pushScan()
    return next
  })
  ipcMain.handle(CHANNELS.resumeCommand, (_e, session) => buildResumeCommand(session))
  ipcMain.handle(CHANNELS.deletePanel, (_e, session) => buildDeletePanel(session))
  ipcMain.handle(CHANNELS.bulkDeletePanel, (_e, sessions) => buildBulkDeletePanel(sessions))
  ipcMain.handle(CHANNELS.openTerminal, (_e, command: string) => openInTerminal(command))
  ipcMain.handle(CHANNELS.focusTty, (_e, tty: string) => focusTty(tty))
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
  stopWatching = watchClaudeState(() => void pushScan())
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
  // Make sure a note typed a moment ago is not lost to the write debounce.
  event.preventDefault()
  await flushNotes()
  app.exit(0)
})
