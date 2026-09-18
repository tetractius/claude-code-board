#!/usr/bin/env bash
#
# Install Claude Code Board on macOS.
#
# The app is ad-hoc signed but not notarised, so macOS quarantines it after a
# download and blocks the first open with "Apple could not verify ... is free of
# malware". This installs it and clears that quarantine flag, so it just opens.
#
#   bash install-macos.sh
#
# Set CCB_DEST to install somewhere other than /Applications.
set -euo pipefail

APP_NAME="Claude Code Board.app"
DEST="${CCB_DEST:-/Applications}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
die()  { printf '\nError: %s\n\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS."

step "Checking this Mac"
ARCH=$(uname -m)
# Releases carry both architectures, so pick the matching one rather than
# installing a bundle this Mac cannot execute - Rosetta does not help, the
# bundle contains a single-architecture Electron.
case "$ARCH" in
  # `uname -m` and electron-builder disagree on the name for Intel: x86_64
  # against x64. The artifact is named with the latter.
  arm64)  ARTIFACT_ARCH=arm64; say "Apple Silicon ($ARCH)." ;;
  x86_64) ARTIFACT_ARCH=x64;   say "Intel ($ARCH)." ;;
  *) die "Unrecognised architecture: $ARCH" ;;
esac

# Look next to this script first, then in Downloads. The zip is preferred: it
# needs no mounting, so there is no volume left behind if something fails.
step "Looking for the download"
ARTIFACT=""
# Array globs, because a filename may contain spaces: an unquoted glob would be
# word-split before it ever reached the filesystem.
#
# The zip is preferred over the dmg: it needs no mounting, so nothing is left
# attached if something fails part way through.
shopt -s nullglob
for dir in "$HERE" "$HOME/Downloads"; do
  candidates=(
    "$dir"/Claude*Code*Board*mac*"$ARTIFACT_ARCH"*.zip
    "$dir"/Claude*Code*Board*mac*"$ARTIFACT_ARCH"*.dmg
  )
  if [ ${#candidates[@]} -gt 0 ]; then
    ARTIFACT="${candidates[0]}"
    break
  fi
done
# Fall back to an unversioned match so an older download still installs, but
# only after the architecture-specific search has come up empty.
if [ -z "$ARTIFACT" ]; then
  for dir in "$HERE" "$HOME/Downloads"; do
    candidates=("$dir"/Claude*Code*Board*-mac.zip "$dir"/Claude*Code*Board*.dmg)
    if [ ${#candidates[@]} -gt 0 ]; then
      ARTIFACT="${candidates[0]}"
      break
    fi
  done
fi
shopt -u nullglob
[ -n "$ARTIFACT" ] || die "Could not find a $ARTIFACT_ARCH .zip or .dmg.
     Put it next to this script, or in ~/Downloads.
     Releases name them Claude-Code-Board-<version>-mac-$ARTIFACT_ARCH.zip"
say "Found $(basename "$ARTIFACT")"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${MOUNT:-}" ] && hdiutil detach "$MOUNT" >/dev/null 2>&1 || true' EXIT
MOUNT=""

step "Unpacking"
case "$ARTIFACT" in
  *.zip)
    ditto -xk "$ARTIFACT" "$TMP" || die "Could not unpack the zip - the download may be incomplete."
    ;;
  *.dmg)
    MOUNT=$(hdiutil attach -nobrowse -readonly "$ARTIFACT" 2>/dev/null \
            | tail -1 | sed 's/.*\(\/Volumes.*\)/\1/')
    [ -d "${MOUNT:-}" ] || die "Could not mount the disk image."
    ditto "$MOUNT/$APP_NAME" "$TMP/$APP_NAME" || die "Could not copy the app out of the disk image."
    hdiutil detach "$MOUNT" >/dev/null 2>&1 || true
    MOUNT=""
    ;;
esac
[ -d "$TMP/$APP_NAME" ] || die "The download did not contain $APP_NAME."

step "Installing to $DEST"
mkdir -p "$DEST" 2>/dev/null || true
[ -w "$DEST" ] || die "$DEST is not writable. Either run with sudo, or install
     somewhere else:  CCB_DEST=\"\$HOME/Applications\" bash $(basename "$0")"

if [ -d "$DEST/$APP_NAME" ]; then
  say "Replacing the existing copy."
  # A running copy would keep its old binaries mapped and confuse the update.
  pkill -f "$DEST/$APP_NAME/Contents/MacOS/" 2>/dev/null && say "Quit the running app." || true
  rm -rf "$DEST/$APP_NAME"
fi
ditto "$TMP/$APP_NAME" "$DEST/$APP_NAME" || die "Could not install to $DEST."

step "Clearing the quarantine flag"
# This is the step that turns a blocked first launch into a normal one.
xattr -cr "$DEST/$APP_NAME"
say "Done."

step "Checking the architecture"
BIN="$DEST/$APP_NAME/Contents/MacOS/Claude Code Board"
# Read this before removing anything, or the error message has nothing to
# describe: `file` on a deleted path reports only that it cannot open it.
FOUND=$(file -b "$BIN" 2>/dev/null | sed 's/.*executable //; s/,.*//')
if printf '%s' "$FOUND" | grep -qi "$ARCH"; then
  say "Matches this Mac ($ARCH)."
else
  rm -rf "$DEST/$APP_NAME"
  die "That download is for ${FOUND:-an unknown architecture}, but this Mac is
     $ARCH. Download the $ARTIFACT_ARCH build instead. Nothing was installed."
fi

step "Checking the signature"
if codesign --verify --deep --strict "$DEST/$APP_NAME" 2>/dev/null; then
  say "Valid (ad-hoc signed)."
else
  die "The signature does not verify - the download is probably corrupt.
     Delete it, download again, and re-run this installer."
fi

step "Opening"
open "$DEST/$APP_NAME"

cat <<TEXT

Installed: $DEST/$APP_NAME

Two things worth knowing:

  * The first time you click a session's terminal chip, macOS will ask for
    Accessibility permission. Allow it, or the board can select the right
    terminal window but cannot switch Spaces to it.

  * The app is ad-hoc signed rather than notarised by Apple. That is why the
    quarantine flag had to be cleared - without this installer, macOS blocks
    the first launch.

TEXT
