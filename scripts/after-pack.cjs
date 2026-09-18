/**
 * Ad-hoc sign the packaged macOS app.
 *
 * With `mac.identity: null` electron-builder skips signing entirely, which
 * leaves the bundle carrying nothing but the Electron binary's own upstream
 * linker-signed signature - identifier "Electron", covering none of our
 * resources. `codesign --verify` fails on it, and on Apple Silicon an invalid
 * signature is fatal: macOS reports the app as "damaged and can't be opened"
 * as soon as it has been through quarantine, with no way past it in the UI.
 *
 * An ad-hoc signature costs nothing, needs no Apple account, and makes the
 * bundle valid. It is not notarised, so a downloaded copy still needs its
 * quarantine flag cleared - but that is a bypassable warning rather than a
 * dead end.
 */
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const run = (args) => execFileSync('codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] })

  // --deep is deprecated for distribution signing but is the right tool for an
  // ad-hoc pass over a bundle with nested helpers and frameworks.
  run(['--force', '--deep', '--sign', '-', '--timestamp=none', app])
  run(['--verify', '--deep', '--strict', app])
  console.log(`  • ad-hoc signed  ${app}`)
}
