// The slug is how a live pid's cwd is matched to its transcript folder. It is
// lossy on purpose - `/` and `_` both collapse to `-` - so it is worth pinning.
import assert from 'node:assert/strict'
import { slugifyCwd } from '../src/core/registry.ts'
import { ttyOf } from '../src/core/scanner.ts'

assert.equal(slugifyCwd('/Users/fil/git/claude-code-board'), '-Users-fil-git-claude-code-board')
// The underscore case: the reason the slug can never be reversed back to a path.
assert.equal(
  slugifyCwd('/Users/fil/git/hive-mono-ENG-591-semantic_docs'),
  '-Users-fil-git-hive-mono-ENG-591-semantic-docs',
)
assert.equal(slugifyCwd('/'), '-')

// `ps` spells "no controlling terminal" differently per platform, and only the
// macOS spelling was handled - on Linux every headless session claimed a
// terminal named `?`.
const claude = (tty: string) => ({ pid: 1, ppid: 0, tty, comm: 'claude', args: 'claude' })
assert.equal(ttyOf(claude('??')), null, 'macOS: no tty')
assert.equal(ttyOf(claude('?')), null, 'Linux: no tty')
assert.equal(ttyOf(claude('-')), null, 'no tty')
assert.equal(ttyOf(claude('ttys000')), 'ttys000', 'macOS terminal')
assert.equal(ttyOf(claude('pts/0')), 'pts/0', 'Linux terminal')

console.log('ok')
