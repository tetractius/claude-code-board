/**
 * What the board accepts as a remote host. No imports, so the renderer can
 * use it to validate the Settings field with exactly the rule main enforces.
 *
 * A host as typed after `ssh`: an alias from ~/.ssh/config, a DNS name or an
 * address. Deliberately not `user@host` or `host:port` - those belong in the
 * ssh config - and never anything starting with `-`, which ssh would read as
 * an option.
 */
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function isValidHost(host: string): boolean {
  return HOST.test(host) && host.length <= 253
}
