#!/usr/bin/env bash
#
# Build the Linux AppImages from macOS, via Docker.
#
# AppImage packaging runs Linux-native tools (mksquashfs, the AppImage runtime),
# so it cannot be cross-built on macOS: electron-builder fails with
# "spawn Unknown system error -86", which is EBADARCH. Running the build inside
# a Linux container is the way round it.
#
# One container is enough for both architectures. Only the Electron payload
# differs by architecture; the packaging tools run as the container's own
# architecture and do not care what they are wrapping. So this uses the host's
# native platform and never needs emulation.
#
# Usage: scripts/dist-linux.sh [electron-builder args...]
#        scripts/dist-linux.sh --arm64      # just one architecture
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

# Already on Linux - CI, or a Linux desktop - so build directly. Docker is only
# needed to escape macOS, where the AppImage tooling cannot run at all.
if [ "$(uname -s)" = "Linux" ]; then
  echo "==> building Linux targets natively"
  npm run build
  npx electron-builder --linux "$@" --publish never
  ls -lh "$ROOT"/release/*.AppImage
  exit 0
fi

case "$(uname -m)" in
  arm64|aarch64) PLATFORM=linux/arm64 ;;
  *)             PLATFORM=linux/amd64 ;;
esac

command -v docker >/dev/null || { echo "docker is required to build Linux targets from macOS" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "the docker daemon is not running" >&2; exit 1; }

# Staged under the repo, not in the system temp directory: Docker on macOS
# (Colima, and Docker Desktop by default) only shares paths under $HOME with its
# VM, so a /var/folders staging directory mounts as an empty volume. The host
# node_modules is deliberately not copied either - it holds a macOS Electron,
# and a container npm install would overwrite it.
STAGE=$ROOT/.linux-build
rm -rf "$STAGE"
mkdir -p "$STAGE" "$ROOT/release"
tar -cf - --exclude node_modules --exclude release --exclude .git --exclude .linux-build . \
  | tar -xf - -C "$STAGE"
[ -f "$STAGE/package.json" ] || { echo "staging failed: no package.json in $STAGE" >&2; exit 1; }

echo "==> building Linux targets in a $PLATFORM container"
docker run --rm --platform "$PLATFORM" \
  -v "$STAGE:/work" -v "$ROOT/release:/out" -w /work \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  node:22-bookworm bash -lc "
    set -e
    npm install --no-audit --no-fund --loglevel=error
    npx electron-builder --linux ${*} --publish never
    cp release/*.AppImage /out/
    chown \$HOST_UID:\$HOST_GID /out/*.AppImage
  "

rm -rf "$STAGE"
ls -lh "$ROOT"/release/*.AppImage
