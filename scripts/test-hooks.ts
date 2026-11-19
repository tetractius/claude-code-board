// The status hook end to end: the shell script Claude runs, the file it
// writes, and how the board reads that back. Runs against a throwaway HOME so
// nothing touches the real ~/.claude.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'ccb-hooks-'))
process.env.HOME = home
const { HOOK_SCRIPT, readHookStatus, installHooks, uninstallHooks, hooksInstalled } =
  await import('../src/core/hooks.ts')

const sid = '0123abcd-0000-4000-8000-00000000beef'
const script = join(home, 'hook.sh')
writeFileSync(script, HOOK_SCRIPT)
const fire = (payload: object) =>
  execFileSync('sh', [script], { input: JSON.stringify(payload), env: { ...process.env, HOME: home } })
const record = join(home, '.claude-board/hooks', `${sid}.json`)

fire({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'secret plan with permission' })
const busy = readFileSync(record, 'utf8')
assert.ok(!busy.includes('secret'), 'prompt text must never reach disk')
assert.equal((await readHookStatus(sid))?.status, 'busy')

fire({ session_id: sid, hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' })
const waiting = await readHookStatus(sid)
assert.equal(waiting?.status, 'waiting')
// The transcript moving on after the prompt means it was answered.
assert.equal((await readHookStatus(sid, waiting!.at + 5000))?.status, 'busy')

fire({ session_id: sid, hook_event_name: 'Notification', message: 'Claude is waiting for your input' })
assert.equal((await readHookStatus(sid))?.status, 'idle')

fire({ session_id: sid, hook_event_name: 'Stop' })
assert.equal((await readHookStatus(sid))?.status, 'idle')

fire({ session_id: sid, hook_event_name: 'SessionEnd' })
assert.equal(existsSync(record), false)

// A session id that is not a uuid is ignored rather than used as a path.
fire({ session_id: '../../evil', hook_event_name: 'Stop' })
assert.equal(existsSync(join(home, 'evil.json')), false)

// Install merges into existing settings and uninstall leaves them as found.
mkdirSync(join(home, '.claude'), { recursive: true })
const settingsFile = join(home, '.claude/settings.json')
const original = {
  theme: 'dark',
  hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
}
writeFileSync(settingsFile, JSON.stringify(original))
await installHooks()
assert.equal(await hooksInstalled(), true)
const installed = JSON.parse(readFileSync(settingsFile, 'utf8'))
assert.equal(installed.theme, 'dark')
assert.equal(installed.hooks.Stop.length, 2)
await installHooks() // idempotent
assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).hooks.Stop.length, 2)
await uninstallHooks()
assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), original)
assert.equal(await hooksInstalled(), false)

// Writes are a rename, not a copy, so they go through the real path: a
// settings.json symlinked from a dotfiles repo stays a symlink, keeps its mode,
// and no temp file is left behind.
const dotfiles = join(home, 'dotfiles')
mkdirSync(dotfiles)
const realSettings = join(dotfiles, 'claude-settings.json')
rmSync(settingsFile)
writeFileSync(realSettings, JSON.stringify(original))
chmodSync(realSettings, 0o600)
symlinkSync(realSettings, settingsFile)
await installHooks()
assert.equal(lstatSync(settingsFile).isSymbolicLink(), true)
assert.equal(JSON.parse(readFileSync(realSettings, 'utf8')).hooks.Stop.length, 2)
assert.equal(statSync(realSettings).mode & 0o777, 0o600)
await uninstallHooks()
assert.equal(lstatSync(settingsFile).isSymbolicLink(), true)
assert.deepEqual(JSON.parse(readFileSync(realSettings, 'utf8')), original)
assert.deepEqual(readdirSync(dotfiles), ['claude-settings.json'])
assert.ok(!readdirSync(join(home, '.claude')).some((f) => f.endsWith('.board-tmp')))

// Unparseable settings are refused, not overwritten.
writeFileSync(settingsFile, '{ not json')
await assert.rejects(installHooks())
assert.equal(readFileSync(settingsFile, 'utf8'), '{ not json')

console.log('ok')
