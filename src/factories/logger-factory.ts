import type { LevelWithSilent, Logger as PinoLogger } from 'pino'
import cluster from 'cluster'
import { format } from 'node:util'

import logger from '../logger'

type MessageLogger = ((message?: unknown, ...args: unknown[]) => void) & {
  debug: (message?: unknown, ...args: unknown[]) => void
  info: (message?: unknown, ...args: unknown[]) => void
  warn: (message?: unknown, ...args: unknown[]) => void
  error: (message?: unknown, ...args: unknown[]) => void
  fatal: (message?: unknown, ...args: unknown[]) => void
  extend: (namespace: string) => MessageLogger
  child: (bindings: Record<string, unknown>) => MessageLogger
}

const stringifyForLog = (input: unknown): string => {
  if (input instanceof Error) {
    return input.stack ?? input.message
  }

  try {
    return format('%O', input)
  } catch {
    return '[Unserializable]'
  }
}

const safeFormat = (template: string, args: unknown[]): string => {
  try {
    return format(template, ...args)
  } catch {
    const extra = args.map(stringifyForLog).join(' ')

    return extra ? `${template} ${extra}` : template
  }
}

const logAtLevel = (
  instance: PinoLogger,
  level: LevelWithSilent,
  message: unknown,
  args: unknown[]
) => {
  if (message instanceof Error) {
    instance[level]({ err: message })
    return
  }

  const errorFromArgs = args.find((arg) => arg instanceof Error) as Error | undefined

  if (errorFromArgs) {
    if (typeof message === 'string') {
      instance[level]({ err: errorFromArgs }, safeFormat(message, args))
      return
    }

    const data = [message, ...args].filter((arg) => !(arg instanceof Error))
    const formatted = data.map(stringifyForLog).join(' ')

    if (formatted) {
      instance[level]({ err: errorFromArgs }, formatted)
    } else {
      instance[level]({ err: errorFromArgs })
    }

    return
  }

  if (typeof message === 'string') {
    instance[level](safeFormat(message, args))
    return
  }

  if (args.length > 0) {
    instance[level]([message, ...args].map(stringifyForLog).join(' '))
    return
  }

  instance[level](message)
}

const createMethod = (instance: PinoLogger, level: LevelWithSilent) =>
  (message?: unknown, ...args: unknown[]) => {
    logAtLevel(instance, level, message, args)
  }

const createMessageLogger = (instance: PinoLogger, scope: string): MessageLogger => {
  const fn = ((message?: unknown, ...args: unknown[]) => {
    logAtLevel(instance, 'debug', message, args)
  }) as MessageLogger

  fn.debug = createMethod(instance, 'debug')
  fn.info = createMethod(instance, 'info')
  fn.warn = createMethod(instance, 'warn')
  fn.error = createMethod(instance, 'error')
  fn.fatal = createMethod(instance, 'fatal')
  fn.child = (bindings: Record<string, unknown>) => createMessageLogger(instance.child(bindings), scope)
  fn.extend = (namespace: string) => {
    const nextScope = scope ? `${scope}:${namespace}` : namespace

    return createMessageLogger(instance.child({ scope: nextScope }), nextScope)
  }

  return fn
}

export const createLogger = (
  namespace: string,
  options: { enabled?: boolean } = { enabled: false },
) => {
  const prefix = cluster.isWorker ? (process.env.WORKER_TYPE ?? 'worker') : 'primary'
  const scope = namespace ? `${prefix}:${namespace}` : prefix
  const instance = logger.child({ scope })

  if (options.enabled && instance.level !== 'debug') {
    instance.level = 'debug'
  }

  const fn = createMessageLogger(instance, scope)

  return fn
}
