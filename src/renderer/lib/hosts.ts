/**
 * A colour per remote host, so a glance at the title bar says which machine
 * the board is showing. This machine has none: colour means "not here".
 *
 * Picked to stay clear of the status colours - yellow busy, green idle, red
 * waiting - and of the blue headless chip, so a host never reads as a status.
 * Assigned by position in Settings, which keeps neighbours distinct; past the
 * six, hues are spread by the golden angle.
 */
const PALETTE = ['#5b8def', '#c06cd6', '#e08a3c', '#3fb8b0', '#d65f8f', '#9aa3ee']

export function hostColor(host: string, hosts: readonly string[]): string | undefined {
  if (!host) return undefined
  const i = hosts.indexOf(host)
  if (i >= 0 && i < PALETTE.length) return PALETTE[i]
  // Not in the list (just removed), or past the palette: a stable hue anyway.
  const n = i >= 0 ? i : [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
  return `hsl(${Math.round((n * 137.508) % 360)} 55% 62%)`
}

/** The colour at a given strength, for borders and fills. */
export function tint(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`
}
