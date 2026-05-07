import fs from 'fs'

import { getEnvFilePath } from './paths'

export type EnvValidationIssue = {
  path: string
  message: string
}

type ParsedEnvLine = {
  index: number
  key: string
  value: string
}

const ENV_LINE_REGEX = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

const SUPPORTED_ENV_KEYS = new Set([
  'SECRET',
  'RELAY_PORT',
  'RELAY_PRIVATE_KEY',
  'WORKER_COUNT',
  'DB_URI',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DB_MIN_POOL_SIZE',
  'DB_MAX_POOL_SIZE',
  'DB_ACQUIRE_CONNECTION_TIMEOUT',
  'READ_REPLICA_ENABLED',
  'READ_REPLICAS',
  'TOR_HOST',
  'TOR_CONTROL_PORT',
  'TOR_PASSWORD',
  'HIDDEN_SERVICE_PORT',
  'REDIS_URI',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_USER',
  'REDIS_PASSWORD',
  'NOSTR_CONFIG_DIR',
  'DEBUG',
  'ZEBEDEE_API_KEY',
  'NODELESS_API_KEY',
  'NODELESS_WEBHOOK_SECRET',
  'OPENNODE_API_KEY',
  'LNBITS_API_KEY',
  'LOG_LEVEL',
])

const RR_KEY_REGEX = /^RR\d+_DB_(HOST|PORT|USER|PASSWORD|NAME|MIN_POOL_SIZE|MAX_POOL_SIZE|ACQUIRE_CONNECTION_TIMEOUT)$/

const INTEGER_KEYS = new Set([
  'RELAY_PORT',
  'WORKER_COUNT',
  'DB_PORT',
  'DB_MIN_POOL_SIZE',
  'DB_MAX_POOL_SIZE',
  'DB_ACQUIRE_CONNECTION_TIMEOUT',
  'READ_REPLICAS',
  'TOR_CONTROL_PORT',
  'HIDDEN_SERVICE_PORT',
  'REDIS_PORT',
])

const BOOLEAN_KEYS = new Set(['READ_REPLICA_ENABLED'])

const RR_INTEGER_KEY_REGEX = /^RR\d+_DB_(PORT|MIN_POOL_SIZE|MAX_POOL_SIZE|ACQUIRE_CONNECTION_TIMEOUT)$/

const SECRET_KEY_REGEX = /(SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i

const parseEnvFile = (): { lines: string[]; parsed: ParsedEnvLine[] } => {
  const envPath = getEnvFilePath()

  if (!fs.existsSync(envPath)) {
    return {
      lines: [],
      parsed: [],
    }
  }

  const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)
  const parsed: ParsedEnvLine[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line || line.trim().startsWith('#')) {
      continue
    }

    const match = line.match(ENV_LINE_REGEX)
    if (!match) {
      continue
    }

    parsed.push({
      index,
      key: match[1],
      value: match[2],
    })
  }

  return {
    lines,
    parsed,
  }
}

export const isSupportedEnvKey = (key: string): boolean => {
  return SUPPORTED_ENV_KEYS.has(key) || RR_KEY_REGEX.test(key)
}

const validateInteger = (key: string, value: string): string | undefined => {
  if (!/^-?\d+$/.test(value.trim())) {
    return `${key} must be an integer`
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    return `${key} must be a safe integer`
  }

  return undefined
}

const validateBoolean = (key: string, value: string): string | undefined => {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === 'false') {
    return undefined
  }

  return `${key} must be true or false`
}

export const validateEnvPair = (key: string, value: string): string | undefined => {
  if (!isSupportedEnvKey(key)) {
    return `${key} is not a supported environment setting`
  }

  if (INTEGER_KEYS.has(key) || RR_INTEGER_KEY_REGEX.test(key)) {
    return validateInteger(key, value)
  }

  if (BOOLEAN_KEYS.has(key)) {
    return validateBoolean(key, value)
  }

  return undefined
}

export const readEnvValues = (): Record<string, string> => {
  const { parsed } = parseEnvFile()
  const values: Record<string, string> = {}

  for (const line of parsed) {
    values[line.key] = line.value
  }

  return values
}

export const upsertEnvValue = (key: string, value: string): void => {
  const envPath = getEnvFilePath()
  const { lines, parsed } = parseEnvFile()

  const existing = parsed.find((line) => line.key === key)
  const replacement = `${key}=${value}`

  if (existing) {
    lines[existing.index] = replacement
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('')
    }
    lines.push(replacement)
  }

  fs.writeFileSync(envPath, lines.join('\n').replace(/\n?$/, '\n'), 'utf-8')
}

export const validateEnvValues = (values: Record<string, string>): EnvValidationIssue[] => {
  const issues: EnvValidationIssue[] = []

  for (const [key, value] of Object.entries(values)) {
    const issue = validateEnvPair(key, value)
    if (!issue) {
      continue
    }

    issues.push({
      path: key,
      message: issue,
    })
  }

  return issues
}

export const isSecretEnvKey = (key: string): boolean => {
  return SECRET_KEY_REGEX.test(key)
}

export const maskSecretValue = (value: string): string => {
  if (!value) {
    return '***'
  }

  if (value.length <= 4) {
    return '*'.repeat(value.length)
  }

  return `${value.slice(0, 2)}***${value.slice(-2)}`
}
