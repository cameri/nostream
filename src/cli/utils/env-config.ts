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
  'MONITOR_PRIVATE_KEY',
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

// A connection URI (DB_URI, REDIS_URI) can carry a password, so it is masked like the other secrets.
const SECRET_KEY_REGEX = /(SECRET|PASSWORD|API_KEY|PRIVATE_KEY|_URI$)/i

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

export const stripQuotes = (value: string): string => {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/**
 * Why a secret cannot be written to `.env` and read back unchanged, or undefined when it can. An unquoted `#` starts a
 * comment for the loader, a newline ends the line, a `$` is expanded by Docker Compose, a quote the loader cannot
 * match changes what it reads, and a backslash inside double quotes is read as an escape by some loaders.
 */
export const getUnsafeSecretReason = (secret: string): string | undefined => {
  if (secret.includes('#')) {
    return 'SECRET cannot contain "#"'
  }
  if (/[\r\n]/.test(secret)) {
    return 'SECRET cannot contain newlines'
  }
  if (secret.includes('$')) {
    // Docker Compose reads the same .env and expands `$NAME`, `${NAME}` and `$$`, which Node's loader leaves alone.
    return 'SECRET cannot contain "$"'
  }
  if (/^["'`]/.test(stripQuotes(secret))) {
    return 'SECRET cannot start with an unmatched quote'
  }
  const trimmed = secret.trim()
  if (trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.includes('\\')) {
    // Node's loader turns `\n` inside double quotes into a newline and Docker Compose expands escapes there too, while
    // the setup parser keeps a backslash as it is, so the readers would end up with different secrets.
    return 'SECRET cannot contain a backslash inside double quotes'
  }
  if (stripQuotes(trimmed) !== trimmed && stripQuotes(trimmed).includes(trimmed[0])) {
    // The loader ends a quoted value at the first closing quote, so a quote inside would cut the secret short.
    return 'SECRET cannot contain the quote it is wrapped in'
  }
  return undefined
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

// .env holds SECRET, which signs the admin session tokens, and other credentials, so only its owner should read
// it. With the usual umask a file created with the default mode is readable by every local account.
const PRIVATE_FILE_MODE = 0o600

/** Writes the .env file readable by its owner only, whether it exists already or not. */
export const writeEnvFile = (envPath: string, content: string): void => {
  // The mode option of the write only applies when the file is created, so a file that exists already is restricted
  // first, before the new content is written into it. A file that does not exist yet fails here, which is fine.
  restrictEnvFile(envPath)

  // A new file is created with the private mode, so it is never readable by others, not even briefly.
  fs.writeFileSync(envPath, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE })

  // Sets exactly the private mode on a new file as well, in case the umask left it with fewer bits.
  restrictEnvFile(envPath)
}

const restrictEnvFile = (envPath: string): void => {
  try {
    fs.chmodSync(envPath, PRIVATE_FILE_MODE)
  } catch {
    // Best effort: a missing file, a file system without Unix permissions, or a file we do not own must not stop
    // the write.
  }
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

  writeEnvFile(envPath, lines.join('\n').replace(/\n?$/, '\n'))
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
