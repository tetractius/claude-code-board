// Bundle src/remote/serve.ts and the core scanner it imports into one plain
// ESM file, which the board uploads to a remote host and runs there with that
// host's Node. One self-contained file is the whole point: nothing has to be
// installed on the remote, and the electron-vite main build would split core
// into shared chunks the remote could not load on its own.
//
// Usage: node scripts/build-remote.mjs [outfile]
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_OUT = join(root, 'out/remote/board-remote.mjs')

export async function buildRemote(outfile = DEFAULT_OUT) {
  await build({
    entryPoints: [join(root, 'src/remote/serve.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    // The oldest Node the remote is asked to have; see src/core/remote.ts.
    target: 'node18',
    legalComments: 'none',
    logLevel: 'warning',
  })
  return outfile
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(await buildRemote(process.argv[2]))
}
