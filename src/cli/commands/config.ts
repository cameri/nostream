import ora from 'ora'
import yaml from 'js-yaml'

import {
  getByPath,
  loadDefaults,
  loadMergedSettings,
  loadUserSettings,
  parseTypedValue,
  saveSettings,
  setByPath,
  validatePathAgainstDefaults,
  validateSettings,
} from '../utils/config'
import {
  isSecretEnvKey,
  isSupportedEnvKey,
  maskSecretValue,
  readEnvValues,
  upsertEnvValue,
  validateEnvPair,
  validateEnvValues,
} from '../utils/env-config'
import { logError, logInfo } from '../utils/output'
import { runStart } from './start'
import { runStop } from './stop'

type ValueType = 'inferred' | 'json'

const toJson = (value: unknown): string => {
  return JSON.stringify(
    value,
    (_key, entry) => {
      if (typeof entry === 'bigint') {
        return entry.toString()
      }

      return entry
    },
    2,
  )
}

const serialize = (value: unknown): string => {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (typeof value === 'string') {
    return value
  }

  if (value === undefined) {
    return 'undefined'
  }

  return yaml.dump(value, { lineWidth: 120 }).trimEnd()
}

const formatLabel = (key: string): string => {
  return key
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const restartRelay = async (): Promise<number> => {
  const spinner = ora('Restarting relay...').start()

  const stopCode = await runStop({ all: true }, [])
  if (stopCode !== 0) {
    spinner.fail('Restart failed while stopping relay')
    return stopCode
  }

  const startCode = await runStart({}, [])
  if (startCode !== 0) {
    spinner.fail('Restart failed while starting relay')
    return startCode
  }

  spinner.succeed('Relay restarted')
  return 0
}

export const runConfigList = async (options: { json?: boolean } = {}): Promise<number> => {
  const settings = loadMergedSettings()

  if (options.json) {
    logInfo(toJson(settings))
    return 0
  }

  logInfo(yaml.dump(settings, { lineWidth: 120 }))
  return 0
}

export const runConfigGet = async (path: string, options: { json?: boolean } = {}): Promise<number> => {
  const settings = loadMergedSettings() as unknown as Record<string, unknown>
  const value = getByPath(settings, path)

  if (value === undefined) {
    if (options.json) {
      process.stderr.write(`${JSON.stringify({ error: { message: `Path not found: ${path}`, code: 1 } })}\n`)
      return 1
    }

    logError(`Path not found: ${path}`)
    return 1
  }

  if (options.json) {
    logInfo(toJson(value))
    return 0
  }

  logInfo(serialize(value))
  return 0
}

export const runConfigSet = async (
  path: string,
  rawValue: string,
  options: {
    restart?: boolean
    validate?: boolean
    valueType?: ValueType
  } = {},
): Promise<number> => {
  const valueType = options.valueType ?? 'inferred'

  const pathIssues = validatePathAgainstDefaults(path)
  if (pathIssues.length > 0) {
    logError(pathIssues[0].message)
    return 1
  }

  const settings = loadUserSettings() as unknown as Record<string, unknown>
  const next = setByPath(settings, path, parseTypedValue(rawValue, valueType))

  if (options.validate !== false) {
    const merged = loadMergedSettings() as unknown as Record<string, unknown>
    const mergedNext = setByPath(merged, path, getByPath(next, path))
    const validationIssues = validateSettings(mergedNext as any)

    if (validationIssues.length > 0) {
      logError('Config update rejected by validation:')
      for (const issue of validationIssues) {
        logError(`- ${issue.path}: ${issue.message}`)
      }

      return 1
    }
  }

  saveSettings(next as any)

  logInfo(`Updated ${path}`)

  if (options.restart) {
    return restartRelay()
  }

  return 0
}

export const runConfigValidate = async (): Promise<number> => {
  const settings = loadMergedSettings()
  const issues = validateSettings(settings)

  if (issues.length === 0) {
    logInfo('Settings are valid')
    return 0
  }

  logError('Settings validation failed:')
  for (const issue of issues) {
    logError(`- ${issue.path}: ${issue.message}`)
  }

  return 1
}

export const runConfigEnvList = async (options: { showSecrets?: boolean } = {}): Promise<number> => {
  const values = readEnvValues()
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b))

  if (entries.length === 0) {
    logInfo('No .env entries found')
    return 0
  }

  for (const [key, value] of entries) {
    const displayValue = options.showSecrets || !isSecretEnvKey(key) ? value : maskSecretValue(value)
    logInfo(`${key}=${displayValue}`)
  }

  return 0
}

export const runConfigEnvGet = async (key: string, options: { showSecrets?: boolean } = {}): Promise<number> => {
  const normalizedKey = key.trim()

  if (!isSupportedEnvKey(normalizedKey)) {
    logError(`Unsupported env key: ${normalizedKey}`)
    return 1
  }

  const values = readEnvValues()
  const value = values[normalizedKey]

  if (value === undefined) {
    logError(`Env key not set: ${normalizedKey}`)
    return 1
  }

  const displayValue = options.showSecrets || !isSecretEnvKey(normalizedKey) ? value : maskSecretValue(value)
  logInfo(displayValue)
  return 0
}

export const runConfigEnvSet = async (key: string, value: string): Promise<number> => {
  const normalizedKey = key.trim()

  if (!isSupportedEnvKey(normalizedKey)) {
    logError(`Unsupported env key: ${normalizedKey}`)
    return 1
  }

  const issue = validateEnvPair(normalizedKey, value)
  if (issue) {
    logError(issue)
    return 1
  }

  upsertEnvValue(normalizedKey, value)
  logInfo(`Updated ${normalizedKey}`)
  return 0
}

export const runConfigEnvValidate = async (): Promise<number> => {
  const values = readEnvValues()
  const issues = validateEnvValues(values)

  if (issues.length === 0) {
    logInfo('Environment settings are valid')
    return 0
  }

  logError('Environment validation failed:')
  for (const issue of issues) {
    logError(`- ${formatLabel(issue.path)} (${issue.path}): ${issue.message}`)
  }

  return 1
}

export const getConfigTopLevelCategories = (): string[] => {
  const defaults = loadDefaults() as unknown as Record<string, unknown>
  return Object.keys(defaults)
}
