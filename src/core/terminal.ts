import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants } from 'node:fs/promises'
import { loadConfig } from './config.ts'

const run = promisify(execFile)

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Escape a string for embedding in an AppleScript string literal. */
function osaQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

async function openOnDarwin(command: string): Promise<string> {
  if (await exists('/Applications/iTerm.app')) {
    await run('osascript', [
      '-e',
      'tell application "iTerm"',
      '-e',
      'activate',
      '-e',
      'set newWindow to (create window with default profile)',
      '-e',
      `tell current session of newWindow to write text "${osaQuote(command)}"`,
      '-e',
      'end tell',
    ])
    return 'iTerm'
  }

  await run('osascript', [
    '-e',
    'tell application "Terminal"',
    '-e',
    'activate',
    '-e',
    `do script "${osaQuote(command)}"`,
    '-e',
    'end tell',
  ])
  return 'Terminal'
}

/**
 * Linux terminals disagree wildly about how to accept a command, so both the
 * executable and its argument template are configurable. `{cmd}` is replaced
 * with the shell command; `exec bash` keeps the window open afterwards.
 */
async function openOnLinux(command: string): Promise<string> {
  const { terminalExec, terminalArgs } = await loadConfig()
  const args = terminalArgs.map((a) => a.replace('{cmd}', `${command}; exec bash`))
  const child = spawn(terminalExec, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return terminalExec
}

/**
 * Launch `command` in a new terminal window. Throws on failure - the caller is
 * expected to fall back to the copyable command, which always works.
 */
export async function openInTerminal(command: string): Promise<string> {
  if (process.platform === 'darwin') return openOnDarwin(command)
  if (process.platform === 'linux') return openOnLinux(command)
  throw new Error(`Opening a terminal is not supported on ${process.platform}`)
}

/** Ask System Events whether an app is running, so we never launch one. */
async function isRunning(processName: string): Promise<boolean> {
  try {
    const { stdout } = await run('osascript', [
      '-e',
      `tell application "System Events" to return (name of processes) contains "${processName}"`,
    ])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

/**
 * Both terminals expose the tty of each tab or session, which is exactly what
 * `ps` gives us for a session's pid - so a session can be matched to the window
 * it is actually sitting in, rather than guessed at.
 *
 * Selecting the window is enough when it is on the current Space. When it is on
 * another one - the case where you have genuinely lost the window - only an
 * accessibility raise makes macOS switch Spaces to it. That needs Accessibility
 * permission, so it is attempted last and its failure is not fatal: the window
 * is already selected either way.
 *
 * The raise deliberately targets whichever window is main rather than matching
 * on title. iTerm rewrites its window titles constantly (the leading glyph
 * tracks session state), so a title match is a race.
 */
const RAISE_MAIN_WINDOW = (process: string) => `
  try
    tell application "System Events" to tell process "${process}"
      set frontmost to true
      perform action "AXRaise" of (first window whose value of attribute "AXMain" is true)
    end tell
  end try`

function focusScript(dev: string): Record<string, string> {
  return {
    iTerm2: `
      tell application "iTerm"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${dev}" then
                select w
                select t
                select s
                ${RAISE_MAIN_WINDOW('iTerm2')}
                return "iTerm"
              end if
            end repeat
          end repeat
        end repeat
      end tell
      return ""`,
    Terminal: `
      tell application "Terminal"
        activate
        repeat with w in windows
          repeat with t in tabs of w
            if tty of t is "${dev}" then
              set selected of t to true
              set frontmost of w to true
              ${RAISE_MAIN_WINDOW('Terminal')}
              return "Terminal"
            end if
          end repeat
        end repeat
      end tell
      return ""`,
  }
}

/**
 * Bring the terminal window running on `tty` to the front.
 *
 * macOS only. Linux has no equivalent that works across window managers -
 * matching a tty back to a window would mean guessing at wmctrl or xdotool and
 * failing differently on every desktop - so it says so rather than half-working.
 */
export async function focusTty(tty: string): Promise<string> {
  if (process.platform !== 'darwin') {
    throw new Error('Focusing a terminal window is only supported on macOS.')
  }

  const dev = tty.startsWith('/dev/') ? tty : `/dev/${tty}`
  // The tty is interpolated into AppleScript, so only ever accept a real one.
  if (!/^\/dev\/tty[a-zA-Z0-9]+$/.test(dev)) throw new Error(`Not a terminal device: ${tty}`)

  const scripts = focusScript(dev)
  for (const [processName, script] of Object.entries(scripts)) {
    if (!(await isRunning(processName))) continue
    const { stdout } = await run('osascript', ['-e', script])
    if (stdout.trim()) return stdout.trim()
  }

  throw new Error(`No open terminal window is on ${tty} — it may have been closed.`)
}

/**
 * Session names as the terminal currently shows them, keyed by tty.
 *
 * Claude keeps the terminal title in step with the session name, so this is
 * the only live source for a `/rename` on a session whose transcript has not
 * been written yet - which, since 2.1.28x, is every freshly started one.
 *
 * macOS only, and best-effort: a failure just means no title from here.
 */
let titleCache: { at: number; titles: Map<string, string> } | null = null
/* Scans also fire on file-system events, and each AppleScript round trip costs
 * ~500ms, so a short cache keeps a burst from hammering iTerm. */
const TITLE_TTL_MS = 3000

export async function readTerminalTitles(): Promise<Map<string, string>> {
  if (titleCache && Date.now() - titleCache.at < TITLE_TTL_MS) return titleCache.titles

  const titles = new Map<string, string>()
  if (process.platform !== 'darwin') return titles

  const script = `
    set out to ""
    tell application "iTerm"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            set out to out & (tty of s) & "\t" & (name of s) & linefeed
          end repeat
        end repeat
      end repeat
    end tell
    return out`

  let stdout: string
  try {
    if (!(await isRunning('iTerm2'))) return titles
    ;({ stdout } = await run('osascript', ['-e', script], { timeout: 10_000 }))
  } catch {
    return titles
  }

  for (const line of stdout.split('\n')) {
    const [dev, ...rest] = line.split('\t')
    if (!dev?.startsWith('/dev/')) continue
    // Claude suffixes the terminal title with "(claude)"; requiring it is what
    // separates a session from a plain shell sitting at "-bash".
    const raw = rest.join('\t')
    if (!/\(claude\)\s*$/.test(raw)) continue
    // "✳ Release page v2026.09.7 (claude)" -> "Release page v2026.09.7"
    const name = raw
      .replace(/\s*\(claude\)\s*$/, '')
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .trim()
    if (name) titles.set(dev.replace('/dev/', ''), name)
  }
  titleCache = { at: Date.now(), titles }
  return titles
}
