/**
 * Render build/icon.svg to the icon files electron-builder wants.
 *
 * Rendering goes through Electron's own Chromium rather than ImageMagick,
 * because the ImageMagick here has no librsvg delegate and its internal SVG
 * renderer mangles gradients and filters.
 *
 * Usage: npm run icon
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const SIZE = 1024

/** The sizes an .icns needs, as (pixels, iconset filename) pairs. */
const ICONSET = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
]

async function render() {
  const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')

  // The window must actually paint for capturePage to return pixels, so it is
  // shown - but parked far off-screen where it cannot be seen.
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: -4000,
    y: -4000,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
  })

  const html = join(buildDir, '.icon-render.html')
  writeFileSync(html, `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`)
  await win.loadFile(html)
  // Give Chromium a beat to rasterise the blur filter before capturing.
  await new Promise((r) => setTimeout(r, 500))

  const png = (await win.capturePage()).toPNG()
  rmSync(html, { force: true })
  writeFileSync(join(buildDir, 'icon.png'), png)
  console.log(`icon.png      ${SIZE}x${SIZE}  ${png.length} bytes`)

  // Downscale in-process; sips flattens the alpha channel on some inputs.
  const master = nativeImage.createFromBuffer(png)
  const iconset = join(buildDir, 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  for (const [size, name] of ICONSET) {
    writeFileSync(
      join(iconset, name),
      master.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    )
  }
  console.log(`icon.iconset  ${ICONSET.length} sizes`)

  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])
    rmSync(iconset, { recursive: true, force: true })
    console.log('icon.icns     built')
  }
}

// NOT a top-level await: Electron emits `ready` only once the ESM main module
// has finished evaluating, so awaiting whenReady at the top level deadlocks.
app.whenReady().then(async () => {
  try {
    await render()
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
