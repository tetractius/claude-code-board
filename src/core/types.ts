/**
 * Shared types for the board. This file must stay free of any imports so that
 * it can be pulled into the renderer (browser) as well as the main process.
 */

export type Kind = 'interactive' | 'background'

/**
 * Live sessions report `status` (idle/busy/waiting); background jobs report
 * `state` (working/blocked/done/failed/stopped). Claude Desktop sessions
 * publish no status heartbeat at all, hence `unknown`. `exited` is ours: a
 * transcript on disk with no process behind it.
 */
export type Status =
  | 'busy'
  | 'waiting'
  | 'idle'
  | 'working'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'exited'
  | 'unknown'

/**
 * `host` covers every non-terminal front end - the desktop app, the VS Code
 * extension, and anything Claude adds later. The specific one is in the label.
 */
export type WhereType = 'tty' | 'host' | 'headless' | 'background' | 'none'

export interface Where {
  type: WhereType
  label: string
}

/** Which source the `lastActivity` timestamp came from, weakest last. */
export type ActivitySource = 'status' | 'job' | 'transcript' | 'history' | 'started' | 'mtime'

export interface JobChild {
  id: string
  href: string
  kind: string
}

export interface BoardSession {
  /** `sessionId` is NOT unique across processes - always key on this instead. */
  key: string
  sessionId: string
  /** What to pass to `claude --resume`; differs from sessionId after a fork. */
  resumeSessionId: string
  jobId?: string
  pid?: number
  kind: Kind
  cwd: string
  where: Where
  entrypoint?: string
  /**
   * The pid of an interactive session parked on this background job - i.e. the
   * terminal the job is actually visible in, if there is one.
   */
  attachedPid?: number
  title: string
  nameSource?: string
  isFork: boolean
  forkParentSessionId?: string
  status: Status
  /** A background job's own last outcome, kept even when `status` is live. */
  jobState?: string
  /** The job created its own git worktree, which a plain `rm` would strand. */
  isolated?: boolean
  /**
   * Started by `claude -p` - a scripted or scheduled run that printed its
   * answer and exited. Claude marks these with `entrypoint: "sdk-cli"`.
   */
  headless: boolean
  /** The slash command it was launched with, e.g. `/daily-standup`. */
  command?: string
  waitingFor?: string
  live: boolean
  startedAt: number
  lastActivity: number
  lastActivitySource: ActivitySource
  lastPrompt?: string
  detail?: string
  needs?: string
  suggestedReply?: string
  children?: JobChild[]
  tokens?: number
  transcriptPath?: string
  /** The Claude version this process is actually running. */
  version?: string
  /**
   * The process is running an older build than the one now installed, so it
   * will keep running the old code until it is restarted. This is the same
   * condition the CLI reports in-session as "Restart to update".
   */
  needsRestart: boolean
}

export interface ScanResult {
  sessions: BoardSession[]
  scannedAt: number
  /** Set when the claude binary could not be run; sessions will be empty. */
  error?: string
  claudeBin?: string
  claudeVersion?: string
}

export interface Note {
  text: string
  updatedAt: number
  /** Denormalised so a note still reads sensibly after the session is collected. */
  cwd?: string
  title?: string
}

export type NoteMap = Record<string, Note>

export interface BoardConfig {
  /** Override for the claude binary; empty means auto-detect. */
  claudeBin: string
  /** Safety-net rescan interval in ms (fs.watch is the primary trigger). */
  pollIntervalMs: number
  /** Max finished sessions to surface; 0 means no limit. */
  finishedLimit: number
  /** Linux terminal emulator used by "Open in Terminal". */
  terminalExec: string
  /**
   * Argument template for the Linux terminal. `{cmd}` is replaced with the
   * shell command to run. Most emulators accept the default.
   */
  terminalArgs: string[]
}

export const DEFAULT_CONFIG: BoardConfig = {
  claudeBin: '',
  pollIntervalMs: 5000,
  finishedLimit: 30,
  terminalExec: 'x-terminal-emulator',
  terminalArgs: ['-e', 'bash', '-lc', '{cmd}'],
}

/** Statuses that mean a human needs to do something. */
export const NEEDS_ATTENTION: ReadonlySet<Status> = new Set<Status>(['waiting', 'blocked'])

/** Statuses that mean the session is over. */
export const TERMINAL_STATUS: ReadonlySet<Status> = new Set<Status>([
  'done',
  'failed',
  'stopped',
  'exited',
])
