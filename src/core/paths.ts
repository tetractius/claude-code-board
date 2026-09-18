import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = homedir()
export const CLAUDE_DIR = join(HOME, '.claude')
export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const REGISTRY_DIR = join(CLAUDE_DIR, 'sessions')
export const JOBS_DIR = join(CLAUDE_DIR, 'jobs')
export const HISTORY_FILE = join(CLAUDE_DIR, 'history.jsonl')

export const BOARD_DIR = join(HOME, '.claude-board')
export const NOTES_FILE = join(BOARD_DIR, 'notes.json')
export const CONFIG_FILE = join(BOARD_DIR, 'config.json')

/** Collapse a leading home directory to `~` for display. */
export function tildify(p: string): string {
  if (p === HOME) return '~'
  return p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p
}
