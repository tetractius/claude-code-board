import { join } from 'node:path'
import { JOBS_DIR } from './paths.ts'
import { readJson } from './util.ts'
import type { JobChild } from './types.ts'

/** A `~/.claude/jobs/<short>/state.json` record - the richest source we have. */
export interface JobState {
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped' | 'starting'
  tempo?: 'idle' | 'blocked' | 'active'
  /** One-line summary of what the job is doing right now. */
  detail?: string
  /** What a blocked job wants from you. */
  needs?: string
  suggestedReply?: string
  tokens?: number
  children?: JobChild[]
  name?: string
  nameSource?: string
  cwd?: string
  sessionId?: string
  /** The id to actually resume; diverges from sessionId after a fork. */
  resumeSessionId?: string
  forkSessionId?: string
  forkParentSessionId?: string
  interactiveLineage?: unknown
  respawnFlags?: string[]
  /** 'none' when the job runs in your own checkout; otherwise it made a worktree. */
  bgIsolation?: string | null
  intent?: string
  createdAt?: string
  updatedAt?: string
}

export function readJobState(jobId: string): Promise<JobState | null> {
  return readJson<JobState>(join(JOBS_DIR, jobId, 'state.json'))
}
