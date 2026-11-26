import { bold, cyan, red, yellow, green } from 'colorette'

const writeStdout = (message: string): void => {
  process.stdout.write(`${message}\n`)
}

const writeStderr = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

export const logStep = (message: string): void => {
  writeStdout(cyan(`• ${message}`))
}

export const logInfo = (message: string): void => {
  writeStdout(message)
}

export const logSuccess = (message: string): void => {
  writeStdout(green(message))
}

export const logWarn = (message: string): void => {
  writeStderr(yellow(message))
}

export const logError = (message: string): void => {
  writeStderr(red(message))
}

export const title = (label: string): string => bold(label)

// C0 controls (including newline, carriage return and ESC), DEL and the C1 controls, which some terminals treat as
// escape introducers.
const TERMINAL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Makes a value that someone else can set, such as the relay name in the settings, safe to print on a terminal:
 * control characters are shown as visible escapes instead of being interpreted, so that the value cannot start new
 * lines, forge other output or send escape sequences. Not for machine-readable output, which is serialized instead.
 */
export const escapeForTerminal = (value: unknown): string =>
  String(value).replace(
    TERMINAL_CONTROL_CHARACTERS,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
  )
