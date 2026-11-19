import { createHash } from 'node:crypto'
import { MARK, runScript, type ScriptOptions } from './remote.ts'

/**
 * The board's own Node, for a remote host that has none.
 *
 * The remote scanner needs Node 18+. When a host has none, the board can put
 * an official Node build there - the same approach VS Code Remote-SSH takes -
 * self-contained in `~/.claude-board/remote/node`. Only the `node` binary is
 * unpacked. It is run by its full path and never put on PATH, so nothing else
 * on the host can see it or conflict with it; `rm -rf ~/.claude-board/remote`
 * removes every trace.
 *
 * Getting the right build is not left to guessing:
 * - the host reports its own OS, CPU and libc (`uname`, and on a Mac
 *   `hw.optional.arm64`, so a shell running under Rosetta still gets arm64);
 * - each build's SHA256 is pinned here, not read from the server it came
 *   from, and a download that does not match is deleted, never run;
 * - the unpacked binary must start and report the expected platform and
 *   version before it replaces anything.
 *
 * The host downloads it itself when it can. When it cannot - no curl or wget,
 * no route to nodejs.org - the board downloads the same pinned file here,
 * checks it, and uploads it over the SSH connection.
 */

export type NodePlatform = 'linux-x64' | 'linux-arm64' | 'darwin-x64' | 'darwin-arm64'

export interface NodeRelease {
  version: string
  baseUrl: string
  /** The `.tar.gz` of each build, from the release's SHASUMS256.txt. */
  sha256: Record<NodePlatform, string>
}

/**
 * Node 24 LTS: supported until April 2028, and its Linux builds need glibc
 * 2.28+ (anything from about 2018 on), which the probe can check up front.
 * Checksums from https://nodejs.org/dist/v24.22.3/SHASUMS256.txt.
 */
export const NODE_RELEASE: NodeRelease = {
  version: 'v24.22.3',
  baseUrl: 'https://nodejs.org/dist',
  sha256: {
    'linux-x64': '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2',
    'linux-arm64': '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8',
    'darwin-x64': '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7',
    'darwin-arm64': 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd',
  },
}

/** Where the board keeps it on the host; remote.ts's bootstrap looks here. */
export const PRIVATE_NODE_DIR = '.claude-board/remote/node'

export interface HostProbe {
  /** `uname -s`: Linux, Darwin, ... */
  os: string
  /** `uname -m`, corrected to arm64 on Apple Silicon. */
  arch: string
  /** `glibc 2.39`, `musl`, or empty when unknown or not Linux. */
  libc: string
  /** `curl`, `wget`, or empty. */
  fetch: string
  /** `sha256sum`, `shasum`, or empty. */
  sum: string
}

export function probeScript(): string {
  return `os=$(uname -s 2>/dev/null); arch=$(uname -m 2>/dev/null)
if [ "$os" = Darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; fi
libc=
if [ "$os" = Linux ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then libc=musl
  else libc="glibc $(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"; fi
fi
fetch=; if command -v curl >/dev/null 2>&1; then fetch=curl; elif command -v wget >/dev/null 2>&1; then fetch=wget; fi
sum=; if command -v sha256sum >/dev/null 2>&1; then sum=sha256sum; elif command -v shasum >/dev/null 2>&1; then sum=shasum; fi
printf '%s{"probe":{"os":"%s","arch":"%s","libc":"%s","fetch":"%s","sum":"%s"}}\\n' '${MARK}' "$os" "$arch" "$libc" "$fetch" "$sum"
`
}

/** Which official build runs on a host, or why none does. */
export function nodePlatform(p: HostProbe): { platform: NodePlatform } | { unsupported: string } {
  const arch = /^(x86_64|amd64)$/.test(p.arch) ? 'x64' : /^(aarch64|arm64)$/.test(p.arch) ? 'arm64' : null
  if (p.os === 'Darwin') {
    return arch ? { platform: `darwin-${arch}` } : { unsupported: `Node has no official build for macOS on ${p.arch}.` }
  }
  if (p.os !== 'Linux') {
    return { unsupported: `The board supports Linux and macOS hosts; this one is ${p.os || 'unknown'}.` }
  }
  if (!arch) return { unsupported: `Node has no official build for Linux on ${p.arch || 'this CPU'}.` }
  if (p.libc === 'musl') {
    return { unsupported: "This host uses musl (Alpine, say), which Node's official builds do not run on." }
  }
  const glibc = /^glibc (\d+)\.(\d+)/.exec(p.libc)
  if (glibc && (Number(glibc[1]) < 2 || (Number(glibc[1]) === 2 && Number(glibc[2]) < 28))) {
    return {
      unsupported: `This host has glibc ${glibc[1]}.${glibc[2]}; Node ${NODE_RELEASE.version.split('.')[0]} needs 2.28 or newer.`,
    }
  }
  return { platform: `linux-${arch}` }
}

function tarball(release: NodeRelease, platform: NodePlatform) {
  const name = `node-${release.version}-${platform}`
  return { name, url: `${release.baseUrl}/${release.version}/${name}.tar.gz` }
}

/**
 * The install itself, run by the host's `sh -s`. Inside one function, like
 * the scanner bootstrap, so an upload read with `head -c` can only ever be
 * the upload. Works in a scratch directory and only replaces the existing
 * `node` once the new one has run.
 */
export function installScript(
  release: NodeRelease,
  platform: NodePlatform,
  mode: 'download' | 'upload',
  size = 0,
): string {
  const { name, url } = tarball(release, platform)
  return `main() {
  d="$HOME/.claude-board/remote"
  t="$d/node-install"
  f="$t/${name}.tar.gz"
  fail() {
    printf '%s{"stage":"fail","reason":"%s","detail":"%s"}\\n' '${MARK}' "$1" \\
      "$(printf '%s' "$2" | tr -d '"\\\\' | tr '\\n\\r\\t' '   ' | cut -c1-300)"
    rm -rf "$t"
  }
  rm -rf "$t" && mkdir -p "$t" || { fail mkdir "could not create $t"; return; }
  if [ ${mode} = download ]; then
    if command -v curl >/dev/null 2>&1; then
      out=$(curl -fsSL --max-time 900 -o "$f" '${url}' 2>&1) || { fail download "$out"; return; }
    elif command -v wget >/dev/null 2>&1; then
      out=$(wget -q -T 60 -O "$f" '${url}' 2>&1) || { fail download "$out"; return; }
    else
      fail download "neither curl nor wget is installed"; return
    fi
  else
    printf '%s\\n' '${MARK}{"stage":"upload"}'
    head -c ${size} > "$f" || { fail upload "could not write $f"; return; }
  fi
  got=$( { sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null; } | awk '{print $1}')
  if [ -z "$got" ]; then
    # An upload was already checked by the board; a download must be checked here.
    [ ${mode} = upload ] || { fail checksum "no sha256sum or shasum to check the download with"; return; }
  elif [ "$got" != '${release.sha256[platform]}' ]; then
    fail checksum "the download's SHA256 is $got, not the pinned one"; return
  fi
  out=$(tar -xzf "$f" -C "$t" '${name}/bin/node' 2>&1) || { fail extract "$out"; return; }
  out=$("$t/${name}/bin/node" -e 'process.stdout.write(process.platform + "-" + process.arch + " " + process.version)' 2>&1)
  [ "$out" = '${platform} ${release.version}' ] || { fail run "$out"; return; }
  rm -rf "$d/node" && mv "$t/${name}" "$d/node" && rm -rf "$t" || { fail install "could not move it to $d/node"; return; }
  printf '%s\\n' '${MARK}{"stage":"done"}'
}
main; exit
`
}

export interface InstallOptions extends ScriptOptions {
  release?: NodeRelease
  /** Fetch a URL here, for the upload fallback. Tests substitute a local read. */
  download?: (url: string) => Promise<Buffer>
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Ask the host what it is. Throws with ssh's explanation if it cannot be reached. */
export async function probeHost(destination: string, opts: ScriptOptions = {}): Promise<HostProbe> {
  const { messages } = await runScript(destination, probeScript(), opts)
  const probe = messages.find((m) => m.probe)?.probe as HostProbe | undefined
  if (!probe) throw new Error(`${destination}: could not tell what kind of machine it is.`)
  return probe
}

/** What installing on this host would do, or why it cannot. */
export async function planNodeInstall(
  destination: string,
  opts: InstallOptions = {},
): Promise<{ platform: NodePlatform; probe: HostProbe } | { unsupported: string }> {
  const probe = await probeHost(destination, opts)
  const plan = nodePlatform(probe)
  return 'platform' in plan ? { platform: plan.platform, probe } : plan
}

function failure(destination: string, msg: Record<string, unknown> | undefined): Error {
  const detail = msg?.detail ? ` (${String(msg.detail)})` : ''
  switch (msg?.reason) {
    case 'download':
      return new Error(`${destination}: could not download Node${detail}.`)
    case 'checksum':
      return new Error(`${destination}: the Node download did not match its pinned checksum, so it was deleted${detail}.`)
    case 'run':
      return new Error(`${destination}: the downloaded Node does not run there${detail}. Nothing was changed.`)
    default:
      return new Error(`${destination}: installing Node failed at "${String(msg?.reason ?? 'unknown')}"${detail}.`)
  }
}

/**
 * Install the board's own Node on a host. Resolves with a one-line summary;
 * throws with the reason when the host is unsupported or every route failed.
 */
export async function installNode(destination: string, opts: InstallOptions = {}): Promise<string> {
  const release = opts.release ?? NODE_RELEASE
  const plan = await planNodeInstall(destination, opts)
  if ('unsupported' in plan) throw new Error(`${destination}: ${plan.unsupported}`)
  const { platform, probe } = plan
  const { url } = tarball(release, platform)
  const where = `~/${PRIVATE_NODE_DIR}`
  const done = (how: string) =>
    `Installed Node ${release.version} (${platform}) in ${where} on ${destination}, ${how}.`
  const long = { ...opts, timeoutMs: opts.timeoutMs ?? 20 * 60_000 }

  // The host fetches it itself: fastest, and nothing crosses the SSH link.
  if (probe.fetch && probe.sum) {
    const { messages } = await runScript(destination, installScript(release, platform, 'download'), long)
    const last = messages.at(-1)
    if (last?.stage === 'done') return done('downloaded there from nodejs.org')
    // A failed or mangled download (a captive proxy, no route) can still be
    // fixed by uploading; a build that does not run there cannot.
    if (last?.reason !== 'download' && last?.reason !== 'checksum') throw failure(destination, last)
  }

  // Fetched here, checked here, and uploaded over the connection.
  const file = await (opts.download ?? fetchBuffer)(url)
  const got = createHash('sha256').update(file).digest('hex')
  if (got !== release.sha256[platform]) {
    throw new Error(`The Node download (${url}) did not match its pinned checksum, so nothing was installed.`)
  }
  const { messages } = await runScript(destination, installScript(release, platform, 'upload', file.length), {
    ...long,
    holdStdin: true,
    onMessage: (msg, stdin) => {
      if (msg.stage === 'upload') stdin.end(file)
      else if (msg.stage === 'fail') stdin.end()
    },
  })
  const last = messages.at(-1)
  if (last?.stage === 'done') return done('uploaded from this machine')
  throw failure(destination, last)
}
