import fs from 'fs'
import yaml from 'js-yaml'
import { mergeDeepRight } from 'ramda'

import { Settings } from '../../@types/settings'
import { getConfigBaseDir, getDefaultSettingsFilePath, getSettingsFilePath } from './paths'

export type ValidationIssue = {
  path: string
  message: string
}

type PathToken =
  | {
      type: 'key'
      key: string
    }
  | {
      type: 'index'
      index: number
    }

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const parsePath = (path: string): PathToken[] => {
  const input = path.trim()

  if (!input) {
    throw new Error('Path is required')
  }

  const tokens: PathToken[] = []
  const segments = input.split('.').map((part) => part.trim())

  for (const segment of segments) {
    if (!segment) {
      throw new Error(`Invalid path segment in: ${path}`)
    }

    const match = segment.match(/^([A-Za-z_][A-Za-z0-9_]*)(\[(\d+)\])*$/)
    if (!match) {
      throw new Error(`Invalid path segment: ${segment}`)
    }

    tokens.push({ type: 'key', key: match[1] })

    const indexes = [...segment.matchAll(/\[(\d+)\]/g)]
    for (const entry of indexes) {
      tokens.push({
        type: 'index',
        index: Number(entry[1]),
      })
    }
  }

  return tokens
}

const formatPathTokens = (tokens: PathToken[]): string => {
  let out = ''

  for (const token of tokens) {
    if (token.type === 'key') {
      out = out ? `${out}.${token.key}` : token.key
      continue
    }

    out = `${out}[${token.index}]`
  }

  return out
}

export const parseValue = (raw: string): unknown => {
  const trimmed = raw.trim()

  if (trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  if (trimmed === 'null') {
    return null
  }

  if (/^-?\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed)
    if (Number.isSafeInteger(asNumber)) {
      return asNumber
    }
  }

  if (/^-?\d+n$/.test(trimmed)) {
    return BigInt(trimmed.slice(0, -1))
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }

  return raw
}

export const parseTypedValue = (raw: string, type: 'inferred' | 'json' = 'inferred'): unknown => {
  if (type === 'json') {
    try {
      return JSON.parse(raw)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid JSON value: ${message}`)
    }
  }

  return parseValue(raw)
}

const toSerializable = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return value.toString()
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry))
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toSerializable(entry)]))
  }

  return value
}

const validateShape = (schema: unknown, candidate: unknown, path: PathToken[], issues: ValidationIssue[]): void => {
  if (schema === undefined || candidate === undefined) {
    return
  }

  const renderedPath = formatPathTokens(path) || '$'

  if (Array.isArray(schema)) {
    if (!Array.isArray(candidate)) {
      issues.push({
        path: renderedPath,
        message: `Expected array, got ${typeof candidate}`,
      })
      return
    }

    if (schema.length === 0) {
      return
    }

    candidate.forEach((entry, index) => {
      const matchesAny = schema.some((schemaEntry) => {
        const localIssues: ValidationIssue[] = []
        validateShape(schemaEntry, entry, [...path, { type: 'index', index }], localIssues)
        return localIssues.length === 0
      })

      if (!matchesAny) {
        issues.push({
          path: formatPathTokens([...path, { type: 'index', index }]),
          message: 'Array element does not match expected schema shape',
        })
      }
    })
    return
  }

  if (isPlainObject(schema)) {
    if (!isPlainObject(candidate)) {
      issues.push({
        path: renderedPath,
        message: `Expected object, got ${typeof candidate}`,
      })
      return
    }

    for (const key of Object.keys(candidate)) {
      if (!(key in schema)) {
        issues.push({
          path: formatPathTokens([...path, { type: 'key', key }]),
          message: 'Unknown setting key',
        })
      }
    }

    for (const key of Object.keys(schema)) {
      validateShape((schema as Record<string, unknown>)[key], (candidate as Record<string, unknown>)[key], [...path, { type: 'key', key }], issues)
    }

    return
  }

  if (candidate === null && schema !== null) {
    issues.push({
      path: renderedPath,
      message: `Expected ${typeof schema}, got null`,
    })
    return
  }

  if (schema !== null && typeof schema !== typeof candidate) {
    issues.push({
      path: renderedPath,
      message: `Expected ${typeof schema}, got ${typeof candidate}`,
    })
  }
}

const pathExistsInSchema = (schema: unknown, tokens: PathToken[]): boolean => {
  let current: unknown = schema

  for (const token of tokens) {
    if (token.type === 'key') {
      if (!isPlainObject(current) || !(token.key in current)) {
        return false
      }
      current = (current as Record<string, unknown>)[token.key]
      continue
    }

    if (!Array.isArray(current)) {
      return false
    }

    current = current[0]
  }

  return true
}

export const ensureSettingsExists = (): void => {
  const configDir = getConfigBaseDir()
  const settingsPath = getSettingsFilePath()
  const defaultsPath = getDefaultSettingsFilePath()

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true })
  }

  if (!fs.existsSync(settingsPath)) {
    fs.copyFileSync(defaultsPath, settingsPath)
  }
}

export const loadDefaults = (): Settings => {
  const defaultsRaw = fs.readFileSync(getDefaultSettingsFilePath(), 'utf-8')
  return yaml.load(defaultsRaw) as Settings
}

export const loadUserSettings = (): Settings => {
  ensureSettingsExists()
  const raw = fs.readFileSync(getSettingsFilePath(), 'utf-8')
  return (yaml.load(raw) as Settings) ?? ({} as Settings)
}

export const loadMergedSettings = (): Settings => {
  return mergeDeepRight(loadDefaults(), loadUserSettings()) as Settings
}

export const saveSettings = (settings: Settings): void => {
  ensureSettingsExists()
  const serialized = yaml.dump(toSerializable(settings), { lineWidth: 120 })
  fs.writeFileSync(getSettingsFilePath(), serialized, 'utf-8')
}

export const getByPath = (settings: unknown, path: string): unknown => {
  const tokens = parsePath(path)
  let current: unknown = settings

  for (const token of tokens) {
    if (token.type === 'key') {
      if (!isPlainObject(current)) {
        return undefined
      }
      current = current[token.key]
      continue
    }

    if (!Array.isArray(current)) {
      return undefined
    }

    current = current[token.index]
  }

  return current
}

const ensureArrayLength = (target: unknown[], minimumLength: number): void => {
  while (target.length <= minimumLength) {
    target.push(undefined)
  }
}

export const setByPath = (settings: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> => {
  const tokens = parsePath(path)
  const clone: Record<string, unknown> = structuredClone(settings)

  if (tokens.length === 0) {
    throw new Error('Path is required')
  }

  let current: unknown = clone

  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]
    const nextToken = tokens[i + 1]

    if (token.type === 'key') {
      if (!isPlainObject(current)) {
        throw new Error(`Cannot set key ${token.key} on non-object path`) 
      }

      const existing = current[token.key]
      if (existing === undefined) {
        current[token.key] = nextToken.type === 'index' ? [] : {}
      } else if (nextToken.type === 'index' && !Array.isArray(existing)) {
        current[token.key] = []
      } else if (nextToken.type === 'key' && !isPlainObject(existing)) {
        current[token.key] = {}
      }

      current = current[token.key]
      continue
    }

    if (!Array.isArray(current)) {
      throw new Error(`Cannot index non-array path at [${token.index}]`)
    }

    ensureArrayLength(current, token.index)

    const existing = current[token.index]
    if (existing === undefined) {
      current[token.index] = nextToken.type === 'index' ? [] : {}
    } else if (nextToken.type === 'index' && !Array.isArray(existing)) {
      current[token.index] = []
    } else if (nextToken.type === 'key' && !isPlainObject(existing)) {
      current[token.index] = {}
    }

    current = current[token.index]
  }

  const last = tokens[tokens.length - 1]

  if (last.type === 'key') {
    if (!isPlainObject(current)) {
      throw new Error(`Cannot set key ${last.key} on non-object path`)
    }

    current[last.key] = value
    return clone
  }

  if (!Array.isArray(current)) {
    throw new Error(`Cannot index non-array path at [${last.index}]`)
  }

  ensureArrayLength(current, last.index)
  current[last.index] = value

  return clone
}

export const validatePathAgainstDefaults = (path: string): ValidationIssue[] => {
  const defaults = loadDefaults() as unknown
  const tokens = parsePath(path)

  if (pathExistsInSchema(defaults, tokens)) {
    return []
  }

  return [
    {
      path,
      message: 'Path does not exist in default settings schema',
    },
  ]
}

export const validateSettings = (settings: Settings): ValidationIssue[] => {
  const issues: ValidationIssue[] = []

  if (!settings.info?.relay_url) {
    issues.push({ path: 'info.relay_url', message: 'relay_url is required' })
  }

  if (!settings.info?.name) {
    issues.push({ path: 'info.name', message: 'name is required' })
  }

  if (!settings.network) {
    issues.push({ path: 'network', message: 'network section is required' })
  }

  if (settings.payments?.enabled && !settings.payments.processor) {
    issues.push({ path: 'payments.processor', message: 'processor is required when payments are enabled' })
  }

  const strategy = settings.limits?.rateLimiter?.strategy
  if (strategy && strategy !== 'ewma' && strategy !== 'sliding_window') {
    issues.push({ path: 'limits.rateLimiter.strategy', message: 'strategy must be ewma or sliding_window' })
  }

  validateShape(loadDefaults(), settings, [], issues)

  return issues
}
