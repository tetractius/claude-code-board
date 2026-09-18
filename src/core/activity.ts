import type { ActivitySource } from './types.ts'

export interface ActivityInputs {
  /** `statusUpdatedAt` / `updatedAt` from ~/.claude/sessions/<pid>.json. */
  registryUpdatedAt?: number
  /** `updatedAt` from ~/.claude/jobs/<id>/state.json. */
  jobUpdatedAt?: number
  /** Timestamp of the last message in the transcript. */
  transcriptAt?: number
  /** Max prompt timestamp for this session in ~/.claude/history.jsonl. */
  historyAt?: number
  startedAt?: number
  transcriptMtime?: number
}

export interface Activity {
  at: number
  source: ActivitySource
}

/**
 * Resolve "when did this session last do something", strongest source first.
 *
 * Transcript mtime is deliberately last and flagged, because it does not mean
 * what it looks like: Claude's maintenance pass rewrites transcripts wholesale,
 * so unrelated sessions in different projects end up sharing an mtime. The
 * `claude-sessions` script uses mtime as its primary signal and is misleading
 * for exactly this reason.
 */
export function resolveActivity(i: ActivityInputs): Activity {
  if (i.registryUpdatedAt) return { at: i.registryUpdatedAt, source: 'status' }
  if (i.jobUpdatedAt) return { at: i.jobUpdatedAt, source: 'job' }
  // Above history because it covers Claude's replies too, not just your
  // prompts - and history.jsonl only ever records prompts typed in the CLI.
  if (i.transcriptAt) return { at: i.transcriptAt, source: 'transcript' }
  if (i.historyAt) return { at: i.historyAt, source: 'history' }
  if (i.startedAt) return { at: i.startedAt, source: 'started' }
  return { at: i.transcriptMtime ?? 0, source: 'mtime' }
}
