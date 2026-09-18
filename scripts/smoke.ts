import { scan } from '../src/core/scanner.ts'
import { buildResumeCommand, buildDeletePanel } from '../src/core/commands.ts'
import { tildify } from '../src/core/paths.ts'

const t0 = Date.now()
const r = await scan({ finishedLimit: 5 })
console.log(`scan: ${Date.now() - t0}ms  bin=${r.claudeBin} v=${r.claudeVersion}`)
if (r.error) { console.error('ERROR:', r.error); process.exit(1) }

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n)
console.log(
  pad('STATUS', 9), pad('WHERE', 11), pad('PID', 6), pad('KIND', 12),
  pad('SRC', 8), pad('TITLE', 34), 'CWD',
)
for (const s of r.sessions) {
  console.log(
    pad(s.status, 9), pad(s.where.label, 11), pad(String(s.pid ?? '-'), 6),
    pad(s.kind + (s.isFork ? ' fork' : ''), 12), pad(s.lastActivitySource, 8),
    pad(s.title, 34), tildify(s.cwd),
  )
}
console.log(`\n${r.sessions.length} sessions`)

const bg = r.sessions.find((s) => s.kind === 'background')
if (bg) {
  console.log('\n--- background sample ---')
  console.log(JSON.stringify({
    title: bg.title, status: bg.status, detail: bg.detail, needs: bg.needs,
    tokens: bg.tokens, children: bg.children, resumeSessionId: bg.resumeSessionId,
  }, null, 2))
}
const live = r.sessions.find((s) => s.live)
if (live) {
  console.log('\n--- resume ---\n' + buildResumeCommand(live))
  for (const b of buildDeletePanel(live).blocks) {
    console.log(`\n--- delete: ${b.title} ---\n` + b.command)
  }
}
