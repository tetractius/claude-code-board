/**
 * What the board accepts as a remote host. No imports, so the renderer can
 * use it to validate the Settings field with exactly the rule main enforces.
 *
 * A destination as typed after `ssh`: a host - an alias from ~/.ssh/config,
 * a DNS name or an address - optionally with a user, as in `me@devbox`. Not
 * `host:port`: a port, key file or jump host belongs in the ssh config. And
 * never anything starting with `-`, which ssh would read as an option.
 */
const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export function isValidHost(destination: string): boolean {
  if (destination.length > 253 + 33) return false
  const at = destination.indexOf('@')
  if (at === -1) return HOST.test(destination) && destination.length <= 253
  const user = destination.slice(0, at)
  const host = destination.slice(at + 1)
  return USER.test(user) && user.length <= 32 && HOST.test(host) && host.length <= 253
}

/** `me@devbox` -> `{ user: 'me', host: 'devbox' }`; no user is null. */
export function splitHost(destination: string): { user: string | null; host: string } {
  const at = destination.indexOf('@')
  return at === -1
    ? { user: null, host: destination }
    : { user: destination.slice(0, at), host: destination.slice(at + 1) }
}
