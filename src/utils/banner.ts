// The startup banner is read by a human in `docker compose logs`, so it is
// composed here as text and written to stdout: through the logger it arrives as
// one JSON object per line with the newlines escaped, which is not a logo, and
// pino is for records rather than for artwork.
//
// Kept out of App so the shape can be tested without a database, a cluster or a
// settings document.
export const BANNER_WIDTH = 74

export const RELAY_BANNER_LINES: readonly string[] = [
  ' ███▄    █  ▒█████    ██████ ▄▄▄█████▓ ██▀███  ▓█████ ▄▄▄       ███▄ ▄███▓',
  ' ██ ▀█   █ ▒██▒  ██▒▒██    ▒ ▓  ██▒ ▓▒▓██ ▒ ██▒▓█   ▀▒████▄    ▓██▒▀█▀ ██▒',
  '▓██  ▀█ ██▒▒██░  ██▒░ ▓██▄   ▒ ▓██░ ▒░▓██ ░▄█ ▒▒███  ▒██  ▀█▄  ▓██    ▓██░',
  '▓██▒  ▐▌██▒▒██   ██░  ▒   ██▒░ ▓██▓ ░ ▒██▀▀█▄  ▒▓█  ▄░██▄▄▄▄██ ▒██    ▒██',
  '▒██░   ▓██░░ ████▓▒░▒██████▒▒  ▒██▒ ░ ░██▓ ▒██▒░▒████▒▓█   ▓██▒▒██▒   ░██▒',
  '░ ▒░   ▒ ▒ ░ ▒░▒░▒░ ▒ ▒▓▒ ▒ ░  ▒ ░░   ░ ▒▓ ░▒▓░░░ ▒░ ░▒▒   ▓▒█░░ ▒░   ░  ░',
  '░ ░░   ░ ▒░  ░ ▒ ▒░ ░ ░▒  ░ ░    ░      ░▒ ░ ▒░ ░ ░  ░ ▒   ▒▒ ░░  ░      ░',
  '   ░   ░ ░ ░ ░ ░ ▒  ░  ░  ░    ░        ░░   ░    ░    ░   ▒   ░      ░',
  '         ░     ░ ░        ░              ░        ░  ░     ░  ░       ░',
]

/**
 * Centres one line of the banner block. A line longer than the width is returned
 * unpadded rather than truncated: half a logo is worse than a wide one.
 */
export const centre = (line: string, width: number = BANNER_WIDTH): string =>
  ' '.repeat(Math.max(0, (width - line.length) >> 1)) + line
