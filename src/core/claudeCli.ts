import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, constants } from 'node:fs/promises'
import { join } from 'node:path'
import { HOME } from './paths.ts'
import { parseVersion } from './util.ts'

const run = promisify(execFile)

/**
 * The shape `claude agents --json --all` emits. Nearly every field is spread
 * conditionally by the CLI, so treat all of them as optional.
 */
export interface AgentEntry {
  pid?: number
  /** 8-hex-char job short id; background sessions only. */
  id?: string
  cwd?: string
  kind?: 'background' | 'interactive'
  startedAt?: number
  sessionId?: string
  name?: string
  /** Live-process status; absent when no process is attached. */
  status?: 'idle' | 'busy' | 'waiting'
  /** Only emitted alongside status === 'waiting'. */
  waitingFor?: string
  /** Background jobs only. */
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped'
}

export interface ClaudeBin {
  path: string
  /** Raw output, e.g. `2.1.246 (Claude Code)`. */
  version: string
  /** Just the number, for comparing against what each session is running. */
  semver: string
}

let cached: ClaudeBin | null = null

/**
 * A GUI app inherits a bare PATH from launchd, so `which claude` alone is not
 * enough - probe the usual install locations too.
 */
function candidates(override: string): string[] {
  const list = [
    override,
    process.env.CLAUDE_BIN ?? '',
    join(HOME, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(HOME, '.claude/local/claude'),
  ]
  return list.filter(Boolean)
}

async function versionOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await run(path, ['--version'], { timeout: 15_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

/** Locate a working `claude` binary. Cached until `resetClaudeBin()` is called. */
export async function resolveClaudeBin(override = ''): Promise<ClaudeBin> {
  if (cached && !override) return cached

  // `which` first: it respects whatever PATH we actually inherited.
  try {
    const { stdout } = await run('/usr/bin/env', ['sh', '-lc', 'command -v claude'], {
      timeout: 15_000,
    })
    const found = stdout.trim()
    if (found) {
      const version = await versionOf(found)
      if (version) return (cached = { path: found, version, semver: parseVersion(version) })
    }
  } catch {
    // fall through to the explicit candidate list
  }

  for (const path of candidates(override)) {
    try {
      await access(path, constants.X_OK)
    } catch {
      continue
    }
    const version = await versionOf(path)
    if (version) return (cached = { path, version, semver: parseVersion(version) })
  }

  throw new Error(
    'Could not find a working `claude` binary. Set one explicitly in Settings, ' +
      'or export CLAUDE_BIN before launching the board.',
  )
}

export function resetClaudeBin(): void {
  cached = null
}

/**
 * `claude agents --json --all` is the spine of every scan. It is the only thing
 * that correctly applies the CLI's own exclusions - sessions parked into a
 * background job, bg entries carrying a jobId, and pids already emitted by the
 * background pass - so we never enumerate ~/.claude/sessions ourselves.
 */
export async function listAgents(bin: string): Promise<AgentEntry[]> {
  const { stdout } = await run(bin, ['agents', '--json', '--all'], {
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('`claude agents --json` did not return an array')
  return parsed as AgentEntry[]
}
