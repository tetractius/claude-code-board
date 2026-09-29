## Claude Code compatibility

Built and tested against **Claude Code 2.1.284**.

Claude 2.1.28x removed `~/.claude/sessions/<pid>.json` and stopped listing
interactive sessions in `claude agents --json`. Board 0.1.0 shows an empty
board on those versions — **0.1.1 or later is required for Claude 2.1.28x**.

One consequence: interactive sessions now report only `active` or `exited`.
Idle/busy/waiting was published solely through the registry that is gone.
Background jobs still report full state.

## Install

### macOS

The app is **ad-hoc signed but not notarised**, so macOS quarantines it after a
download and blocks the first open with *"Apple could not verify … is free of
malware"* and a **Move to Bin** button. Since macOS 15 there is no
Control-click → Open shortcut any more.

Download the `*-mac-arm64.zip` (Apple Silicon) or `*-mac-x64.zip` (Intel) and
`install-macos.sh` into the same folder — or just leave both in `~/Downloads` — then run:

```bash
bash ~/Downloads/install-macos.sh
```

Run it with `bash`, don't double-click it: a downloaded `.sh` opened from Finder
hits a Gatekeeper prompt of its own.

The installer checks your Mac's architecture, installs to `/Applications`,
clears the quarantine flag, verifies the signature and opens the app. Re-running
it upgrades in place. Set `CCB_DEST` to install elsewhere.

<details>
<summary>Or do it by hand</summary>

```bash
ditto -xk ~/Downloads/Claude-Code-Board-<version>-mac-arm64.zip /Applications \
  && xattr -cr "/Applications/Claude Code Board.app" \
  && open "/Applications/Claude Code Board.app"
```

Clearing the quarantine flag **before** the first open is what skips the dialog.
If you open it first, you can still get past the warning via
System Settings → Privacy & Security → **Open Anyway**.
</details>

The first time you click a session's `↗ ttys…` chip, macOS asks for
Accessibility permission. Allow it, or the board can select the right terminal
window but cannot switch Spaces to it.

### Linux

```bash
chmod +x Claude-Code-Board-*-linux-x86_64.AppImage   # or -linux-arm64
./Claude-Code-Board-*-linux-x86_64.AppImage
```

## Which file

| File | For |
| --- | --- |
| `*-mac-arm64.dmg` / `*-mac-arm64.zip` | macOS, Apple Silicon |
| `*-mac-x64.dmg` / `*-mac-x64.zip` | macOS, Intel |
| `*-linux-x86_64.AppImage` | Linux, x86-64 |
| `*-linux-arm64.AppImage` | Linux, ARM64 |
| `install-macos.sh` | the macOS installer described above |
