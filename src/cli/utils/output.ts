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
