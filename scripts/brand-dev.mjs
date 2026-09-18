/**
 * Rebrand the local Electron.app used by `npm run dev`.
 *
 * Running from source launches Electron's own bundle, so macOS takes the app
 * name, the process name and the icon from *its* Info.plist and executable -
 * which is why the app switcher and Activity Monitor say "Electron" no matter
 * what `app.setName()` does. Patching that bundle is the only way to fix it in
 * dev. Packaged builds get their identity from electron-builder and never come
 * through here.
 *
 * Three things have to change together: the bundle name keys, the executable
 * filename (that is what Activity Monitor reports), and `electron/path.txt`,
 * which is how the npm launcher finds the binary.
 *
 * Editing a bundle invalidates its code signature, so it is re-signed ad-hoc
 * and fully rolled back if anything fails. Runs from postinstall and never
 * fails the install - dev mode under the wrong name still works fine.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Claude Code Board'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules/electron')
const appDir = join(electronDir, 'dist/Electron.app')
const contents = join(appDir, 'Contents')
const plist = join(contents, 'Info.plist')
const pathFile = join(electronDir, 'path.txt')
const icns = join(root, 'build/icon.icns')

// Backups live outside the bundle: codesign refuses to sign a bundle that
// contains stray unsigned files, and a backup in Contents/ is exactly that.
const plistBackup = join(tmpdir(), 'ccb-electron-Info.plist.bak')
const pathBackup = join(tmpdir(), 'ccb-electron-path.txt.bak')

if (process.platform !== 'darwin' || !existsSync(plist)) process.exit(0)

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' })
const oldExec = join(contents, 'MacOS/Electron')
const newExec = join(contents, 'MacOS', NAME)

if (existsSync(newExec) && !existsSync(oldExec)) {
  console.log(`dev Electron already branded as "${NAME}"`)
  process.exit(0)
}

try {
  copyFileSync(plist, plistBackup)
  copyFileSync(pathFile, pathBackup)

  for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) {
    run('plutil', ['-replace', key, '-string', NAME, plist])
  }
  // Activity Monitor names a process after its executable file, not the bundle.
  renameSync(oldExec, newExec)
  writeFileSync(pathFile, `Electron.app/Contents/MacOS/${NAME}`)
  if (existsSync(icns)) copyFileSync(icns, join(contents, 'Resources/electron.icns'))

  run('codesign', ['--force', '--sign', '-', '--timestamp=none', appDir])
  run('codesign', ['--verify', '--no-strict', appDir])

  console.log(`branded dev Electron as "${NAME}"`)
} catch (err) {
  if (existsSync(newExec) && !existsSync(oldExec)) renameSync(newExec, oldExec)
  if (existsSync(plistBackup)) copyFileSync(plistBackup, plist)
  if (existsSync(pathBackup)) copyFileSync(pathBackup, pathFile)
  try {
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', appDir])
  } catch {
    // `node node_modules/electron/install.js` restores a clean copy.
  }
  console.warn(`skipped dev branding: ${err.stderr?.toString().trim() || err.message}`)
} finally {
  rmSync(plistBackup, { force: true })
  rmSync(pathBackup, { force: true })
}
