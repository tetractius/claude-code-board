# Working on this repo

## Before cutting a release

**Write the changelog into the tag, not into a file.** The release body is
assembled by `.github/workflows/release.yml` as:

```
<the annotated tag's message>
---
.github/RELEASE_NOTES.md
```

So:

1. Bump `version` in `package.json`.
2. Add a row to the compatibility table at the top of `README.md` saying which
   Claude Code version this was built and tested against, and what it fixes.
3. Tag with the changelog as the message. **`--cleanup=verbatim` is required**:
   without it git treats every line starting with `#` as a comment and deletes
   it, which silently ate the heading from v0.1.3 and v0.1.4.

   ```bash
   git tag -a --cleanup=verbatim v0.1.5 -m "## Fixed in 0.1.5

   <what changed, and why it mattered>

   Built and tested against **Claude Code 2.1.NNN**."
   git push origin main v0.1.5
   ```

   Check it survived before pushing:

   ```bash
   git tag -l --format='%(contents)' v0.1.5 | head -1   # must show the heading
   ```

`.github/RELEASE_NOTES.md` is the **standing install guide only**. Do not put a
version number or a "fixed in X" section in it: it is reused by every release,
so v0.1.3 once shipped with v0.1.2's changelog.

To correct a release that is already out, re-annotate the tag
(`git tag -f -a vX -m "..."`), force-push it, and the workflow reruns and
rewrites the body.

## Claude Code moves under us

The board reads Claude's own on-disk state, which changes without notice. Two
versions have already broken it:

- **2.1.28x** stopped writing `~/.claude/sessions/<pid>.json` and stopped
  listing interactive sessions in `claude agents --json`.
- **2.1.285** stopped writing a session's transcript until some time after it
  starts, so a new session exists on disk only as
  `projects/<slug>/<uuid>/`.

When something "stops working", check what Claude writes now before changing
board code — `ls -lt ~/.claude/projects/*/`, `ls ~/.claude/sessions/`,
`claude agents --json --all | head`. Then record the finding in the README
compatibility table.

Prefer sources that survive version changes: `ps` (pid, tty, `--resume <uuid>`),
`/proc` or `lsof` for cwd, and the transcript itself. Treat anything under
`~/.claude` as liable to move.

## Platform

`src/core` is plain Node with no Electron imports, so the same scanner can back
a server later. Anything macOS-only — AppleScript for terminal titles and for
focusing a window — must be guarded with `process.platform` and degrade to a
board that still works, never to a crash.

## Checks

`npm run smoke` prints the scan as a table; it is the fastest way to see what
the board will show. Generated delete scripts are destructive, so test them with
`rm` replaced by `echo` rather than running them.
