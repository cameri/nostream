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

  if (typeof message === 'string') {
    instance[level](format(message, ...args))
    return
  }

  if (args.length > 0) {
    instance[level](format('%O', [message, ...args]))
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
  options: { enabled?: boolean; stdout?: boolean } = { enabled: false, stdout: false },
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
