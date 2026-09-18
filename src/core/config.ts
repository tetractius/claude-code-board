import { mkdir, writeFile } from 'node:fs/promises'
import { BOARD_DIR, CONFIG_FILE } from './paths.ts'
import { readJson } from './util.ts'
import { DEFAULT_CONFIG, type BoardConfig } from './types.ts'

let cache: BoardConfig | null = null

export async function loadConfig(): Promise<BoardConfig> {
  if (cache) return cache
  const stored = await readJson<Partial<BoardConfig>>(CONFIG_FILE)
  cache = { ...DEFAULT_CONFIG, ...(stored ?? {}) }
  return cache
}

export async function saveConfig(patch: Partial<BoardConfig>): Promise<BoardConfig> {
  const next = { ...(await loadConfig()), ...patch }
  cache = next
  await mkdir(BOARD_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}
