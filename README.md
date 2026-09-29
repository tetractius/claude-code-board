# Claude Code Board

[![Build](https://github.com/tetractius/claude-code-board/actions/workflows/build.yml/badge.svg)](https://github.com/tetractius/claude-code-board/actions/workflows/build.yml)

Prebuilt macOS and Linux downloads are on the
[releases page](https://github.com/tetractius/claude-code-board/releases).

A dark-only desktop board for every Claude Code session on the machine — live,
background, and finished-but-not-yet-collected — with per-session notes and
copy-ready resume/delete commands.

## Claude Code versions

The board reads Claude's own on-disk state, and Claude changes it. What each
board release expects:

| Board | Claude Code | Status reporting |
| --- | --- | --- |
| **0.1.3** | **2.1.285** (built and tested against) | as 0.1.2, and finds sessions that have no transcript yet |
| 0.1.2 | 2.1.284 | misses a session started as a bare `claude` until its transcript is written |
| 0.1.1 | 2.1.284 | as 0.1.2, but its delete guard fails open — **do not use** |
| 0.1.0 | up to 2.1.273 | full `idle` / `busy` / `waiting` |

Claude 2.1.28x removed `~/.claude/sessions/<pid>.json` and stopped listing
interactive sessions in `claude agents --json`. 0.1.0 shows an empty board on
those versions; 0.1.1 finds the sessions again but can only report whether one
is running, not what it is doing — nothing publishes idle/busy/waiting any more.
The exact release that dropped the registry is somewhere in 2.1.274–2.1.283,
untested here.

2.1.285 goes further: a freshly started session gets no transcript file at all
until later, only a `projects/<slug>/<uuid>/` directory beside it. 0.1.2 matched
a process to its session through that transcript, so such a session was missing
from the board entirely and a `/rename` had nothing to read. 0.1.3 takes the id
from `--resume` on the command line where there is one, falls back to the
session directory, and reads the name from the terminal title — which Claude
keeps in step with `/rename` and is the only live source while the transcript
does not exist.

Background jobs are unaffected either way: `claude agents --json` still reports
their `state`.

## Run it

```bash
./run.sh          # installs if needed, then starts in dev mode
```

or, by hand:

```bash
npm install
npm run dev       # electron-vite dev, renderer hot-reloads
npm run build     # typecheck + bundle
```

## Packaging

```bash
npm run dist:mac      # this Mac's architecture only
npm run dist:mac:all  # both, as CI does
npm run dist:linux    # both Linux architectures
```

**Linux builds need Docker.** AppImage packaging runs Linux-native tools
(`mksquashfs`, the AppImage runtime), so it cannot be cross-built on macOS —
electron-builder fails with `spawn Unknown system error -86`, which is EBADARCH.
`scripts/dist-linux.sh` runs the build inside a Linux container instead.

One container covers both architectures, and no emulation is involved: only the
Electron payload differs by architecture, while the packaging tools run as the
container's own architecture and do not care what they are wrapping. Sources are
staged into `.linux-build/` rather than the system temp directory, because
Docker on macOS only shares paths under `$HOME` with its VM — a `/var/folders`
staging directory mounts as an empty volume. The host `node_modules` is never
copied in; it holds a macOS Electron that a container `npm install` would
overwrite.

To check an AppImage without a Linux machine, read its payload directly rather
than executing it — the file is `[ELF runtime][squashfs]`, and the filesystem
begins at `e_shoff + e_shnum * e_shentsize` from `readelf -h`, which is the same
number the runtime reports as `--appimage-offset`.

### Opening it on someone else's Mac

The build is **ad-hoc signed** and **not notarised**. `mac.identity` is `null`,
so electron-builder skips signing; `scripts/after-pack.cjs` then signs the
bundle ad-hoc itself. That step is not optional on Apple Silicon: without it the
bundle carries only the Electron binary's upstream linker-signed signature
(identifier `Electron`, covering none of our resources), `codesign --verify`
fails, and macOS calls the app **“damaged and can’t be opened”** with no way
past it in the UI.

Ad-hoc signing makes the bundle valid, but not notarised — so a Mac that
downloaded it still blocks the first open, with *“Apple could not verify … is
free of malware”* and a **Move to Bin** button. That dialog can be got past
(System Settings → Privacy & Security → Open Anyway); the old “damaged” one
could not. Note that since macOS 15 there is no Control-click → Open shortcut
any more.

**Send people `install-macos.sh`**, which ships in `release/` alongside the
artifacts. They put it next to the downloaded `.zip` or `.dmg` — or just leave
both in `~/Downloads` — and run:

```bash
bash ~/Downloads/install-macos.sh
```

Tell them to run it with `bash`, not to double-click it: a downloaded `.sh`
opened from Finder hits a Gatekeeper prompt of its own.

It picks the build matching the Mac's architecture, installs to
`/Applications`, clears the quarantine flag, verifies the signature, and opens
the app. `CCB_DEST` overrides the destination. Re-running it upgrades in place,
quitting a running copy first.

Doing it by hand instead — clear the quarantine flag before the first open and
the dialog never appears. From the zip:

```bash
ditto -xk ~/Downloads/Claude-Code-Board-0.1.0-mac-arm64.zip /Applications \
  && xattr -cr "/Applications/Claude Code Board.app" \
  && open "/Applications/Claude Code Board.app"
```

or from the dmg:

```bash
MNT=$(hdiutil attach -nobrowse ~/Downloads/Claude-Code-Board-0.1.0-mac-arm64.dmg \
      | tail -1 | sed 's/.*\(\/Volumes.*\)/\1/') \
  && ditto "$MNT/Claude Code Board.app" "/Applications/Claude Code Board.app" \
  && hdiutil detach "$MNT" \
  && xattr -cr "/Applications/Claude Code Board.app" \
  && open "/Applications/Claude Code Board.app"
```

Neither is needed on the machine that built it, since nothing ever quarantined
it.

Notarising properly (no warning at all) needs a paid Apple Developer account:
set `CSC_LINK`/`CSC_KEY_PASSWORD` to a Developer ID certificate, drop the
`identity: null`, and add `notarize` to the `mac` config.

## Icon and app name

`build/icon.svg` is the source. `npm run icon` re-renders it to `icon.png` and
`icon.icns`, rasterising through Electron's own Chromium because the
ImageMagick here has no librsvg delegate and its internal SVG renderer mangles
gradients and filters. The committed icon files are already current; you only
need this after editing the SVG.

Running from source launches Electron's *own* app bundle, so macOS would
otherwise call the app "Electron" in the app switcher and Activity Monitor no
matter what the code says. `scripts/brand-dev.mjs` — wired into `postinstall`,
or run on demand with `npm run brand:dev` — renames that bundle, its executable
and `electron/path.txt`, then re-signs it ad-hoc, rolling back completely if any
step fails. Packaged builds take their identity from electron-builder and never
touch this path.

## What the cards show

Sessions come from two places, because no single source lists them all any
more. `claude agents --json --all` reports background jobs. Live interactive
sessions are discovered from the `<pid>.<hash>.key` file each one leaves in
`~/.claude/sessions/`, with `lsof` for its working directory and the newest
transcript in that directory's project folder. Each is then enriched from:

| Source | What it contributes | |
| --- | --- | --- |
| `~/.claude/jobs/<id>/state.json` | background `detail`, `needs`, linked PRs, token count, fork lineage, resume id | |
| `~/.claude/projects/**/*.jsonl` | the `/rename` title, model-generated title, last prompt, entrypoint, last message time | |
| `~/.claude/history.jsonl` | when you last prompted the session (CLI only) | |
| `ps` | which terminal a session is sitting in, and whether a pid is really Claude | |
| `lsof -d cwd` | a live session's working directory | |
| `~/.claude/sessions/<pid>.json` | *was* live status, `waitingFor`, entrypoint, running version | **gone in 2.1.28x** |
| `parkedJobId` across `~/.claude/sessions/*.json` | *was* which terminal a background job is attached to | **gone with it** |

Two features went with that file. Interactive sessions no longer report
`idle`/`busy`/`waiting` — only `active` or `exited`. And a background job that
has a terminal attached is no longer shown as sitting in that terminal, because
nothing records the attachment; it reads as `background` again. The code that
reads both is still there and starts working the moment Claude publishes an
equivalent.

Card titles come from the transcript's `custom-title` record first — the name
you set with `/rename`. Nothing else survives a session ending, so
the transcript is the only place a rename is kept. Only if there
is no rename does the card fall back to the model-generated `ai-title`, then to
the directory name.

Claude 2.1.28x stopped writing `~/.claude/sessions/<pid>.json` and stopped
listing interactive sessions in `claude agents --json`, so neither source knows
they exist any more. They are found instead from the `<pid>.<hash>.key` file
each live session still leaves, `lsof` for its working directory, and the newest
transcript in that directory's project folder. Alive-versus-exited is still exact: a `.key` file with a live pid behind it
means running, and nothing means gone. What is lost is the finer split — those
sessions show as **`active`** rather than idle/busy/waiting, which was only ever
published through the registry that is now gone.

A background job whose worker has no terminal is still on screen if an
interactive session is *parked* on it — that session's registry entry carries
`parkedJobId`, and `claude agents --json` hides it to avoid listing the same
work twice. The board reads it anyway, because otherwise a session you are
looking at in iTerm gets labelled a headless background job. Such a card shows
both its terminal and a `bg` chip.

For such a card the status badge reports the *live* status of the attached
terminal, not the job's `state`. A job's `state` stays `done` after its batch
run ends, but if you have attached and are prompting it again the session is
plainly not finished — calling it done both mislabels it and hides it behind
the "finished" toggle. The run's own outcome stays visible as a `job done` chip.

### Headless runs

A session started by `claude -p` — a script or a cron job that printed its
answer and exited — is marked by Claude with `entrypoint: "sdk-cli"`. Those
cards carry a `⚡ -p` tag with the slash command that launched them, e.g.
`⚡ -p /daily-standup`, and the toolbar has a chip that filters the board down
to just them.

The entrypoint is read from the transcript, which is the only place it survives
once a run exits. It is also the only
reliable marker: these runs report `entrypoint: "cli"` on their *process*, write
nothing to `history.jsonl`, and Claude never generates an `ai-title` for them,
so their cards fall back to the directory name — which is exactly why the tag
and the filter are worth having.

### Selecting several sessions

Every card has a checkbox, and `space` ticks the keyboard-selected one. With a
selection active the toolbar shows how many are ticked and offers **Delete
selected**, which builds a single script covering all of them — guarded and
unguarded, as for one session. The guarded version checks each session
separately and reports which it skipped, since a bulk delete is exactly where
you least want to remove the session you are sitting in.

### Sessions that are not in a terminal

A session's `entrypoint` is `claude-<host>` for every non-terminal front end —
`claude-desktop`, `claude-vscode`, and whatever comes next — so the card names
the host rather than showing a dash.

Those hosts never published a status heartbeat, and since 2.1.28x nothing does,
so they show as `active` like any other running session. They also never write
to `history.jsonl`, which only records prompts typed in the CLI —
which is why the activity ladder reads the last message timestamp straight out
of the transcript.

`/rename` is likewise not visible for them: a CLI rename writes a `custom-title`
record into the transcript and updates the registry `name`, but a session
renamed in the VS Code extension keeps `nameSource: "derived"` and writes no
`custom-title`, so there is nothing on disk for the board to read.

**Last activity** deliberately never uses the transcript's file mtime as a
primary signal. Claude rewrites transcripts wholesale during compaction, so
unrelated sessions in different projects end up sharing an mtime. Where mtime is
the only thing left, the card marks the time with `*`.

## Keyboard

| Key | Does |
| --- | --- |
| `Ctrl+F` / `Cmd+F` | focus the filter box and select what is in it |
| `Enter` in the filter box | hand off to the grid, selecting the first result |
| `↑ ↓ ← →` | move between cards (down and up step a full row) |
| `Enter` on a card | jump to that session's terminal — same as clicking its `↗ ttys…` chip |
| `e` on a card | jump into its note |
| `Enter` in a note | hand control back to the card |
| `Cmd/Ctrl+Enter` in a note | insert a newline |
| `Escape` | leave the filter box or note, or clear the card selection |

Enter is deliberately inverted inside a note: plain `Enter` leaves, and
newlines move to `Cmd/Ctrl+Enter`. The board is driven from the keyboard, and
without that there is no way out of a note without reaching for the mouse.

`Enter` on a card with no terminal to jump to — a background job, a desktop
session, a finished one — does nothing at all, by design. Arrow keys belong to
whatever note you are editing while a note has focus, so they never steal it.

## Jumping to a session's terminal

macOS only. Both iTerm and Terminal expose the tty of every tab, and `ps` gives
us the tty for a session's pid, so the `↗ ttys011` chip on a card jumps straight
to the window that session is running in — no guessing.

Selecting the window is enough when it is on the current Space. When it is on
another one — the case where you have actually lost the window — macOS only
follows if the app can perform an accessibility raise, so grant **System
Settings → Privacy & Security → Accessibility → Claude Code Board** on first
use. Without it the window is still selected; the Space just may not switch.
The raise targets whichever window is main rather than matching on title,
because iTerm rewrites its titles constantly as session state changes.

Linux has no equivalent that works across window managers, so the chip is not a
button there.

## Restart to update

Each session records the Claude version its process is actually running. When
that is older than the installed binary, the card shows `↻ restart to update`
and the toolbar tallies how many are affected — the same condition the CLI
reports in-session as "Restart to update". A running process keeps executing the
build it started with, so an update installed underneath it does nothing until
the session restarts.

Resuming such a session is itself the fix, since the new process starts on the
installed build; the resume dialog says so.

## Notes

Stored in `~/.claude-board/notes.json`, keyed by session uuid, written
atomically and debounced. The working directory and title are copied into each
note so it still makes sense after Claude collects the session.

Nothing is ever written inside `~/.claude/` — Claude's own job deletion and
transcript compaction actively rewrite that tree.

## Deleting

There is no `claude` subcommand for it — deletion lives only in the interactive
agents view (`ctrl+x`) — so the board generates a **single guarded command** you
copy and run yourself. It never executes anything.

The panel offers two options, each with its own copy button so you take one or
the other:

**Guarded** refuses while any live Claude process still holds the session. It
matches both `jobId` and `parkedJobId` across `~/.claude/sessions/*.json` where
those still exist, so it catches the background worker *and* any terminal
attached to the job, and cross-checks every pid with `ps`.

**Unguarded** removes the same things with no check at all, for when you already
know nothing is running.

Both repeat their own variable declarations rather than sharing them, because
they are copied independently — a block referring to variables set in the other
would run with them empty. The `${VAR:?}` guards are the backstop: without them
an empty `$JOB` would turn `rm -rf "$HOME/.claude/jobs/$JOB"` into a command
that removes every job.

Two things it does not do, and says so when they apply. It never touches the
working directory — with `bgIsolation: none` the cwd is your own checkout, not
something Claude created. And if a job *did* make its own worktree, a plain `rm`
would strand it, so the panel tells you to use `ctrl+x` instead, which removes
the worktree and applies Claude's git guards.

A job that is *blocked* waiting on you has nothing running, so the guard will
not stop you deleting it. The panel warns and quotes what it is waiting for.

## Layout

`src/core/` is plain Node with no Electron imports — the same scanner is meant
to back an HTTP/SSE server for monitoring remote hosts later. `src/renderer/lib/api.ts`
is the single seam the UI talks through.
