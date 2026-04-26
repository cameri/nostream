export type CommandContext = {
  cwd: string
}

export type CommandHandler<T = Record<string, unknown>> = (options: T, rawArgs: string[]) => Promise<number>

export type StartOptions = {
  tor?: boolean
  i2p?: boolean
  nginx?: boolean
  debug?: boolean
  port?: number
  detach?: boolean
}

export type StopOptions = {
  tor?: boolean
  i2p?: boolean
  nginx?: boolean
  local?: boolean
  all?: boolean
}

export type SetupOptions = {
  yes?: boolean
  start?: boolean
}
