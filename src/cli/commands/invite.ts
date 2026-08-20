import knex, { Knex } from 'knex'

import { DatabaseClient } from '../../@types/base'
import { InviteCode } from '../../@types/invite-code'
import { IInviteCodeRepository } from '../../@types/repositories'
import { Settings } from '../../@types/settings'
import { InviteCodeRepository } from '../../repositories/invite-code-repository'
import { issueInviteCode, parseRelayPubkey } from '../../utils/nip43-invites'
import { loadMergedSettings } from '../utils/config'
import { readEnvValues } from '../utils/env-config'
import { logInfo } from '../utils/output'

const DB_ENV_KEYS = ['DB_URI', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'] as const
const CLI_DB_ACQUIRE_TIMEOUT_MS = 3000

export const INVITE_CLI_DB_HINT = `If Nostream is running in Docker, Postgres is not published to the host. Run:
  docker compose exec nostream node src/cli/index.js invite create

If PostgreSQL is local, set DB_URI or DB_HOST (see .env.example).`

export type InviteCreateOptions = {
  uses?: number
  expiresIn?: number
  json?: boolean
}

export type InviteCreateDependencies = {
  loadSettings?: () => Settings
  issue?: typeof issueInviteCode
  createRepository?: (db: DatabaseClient) => IInviteCodeRepository
  createDbClient?: () => DatabaseClient
  now?: () => number
}

const unquoteEnvValue = (value: string): string => {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export const applyDbEnvFileDefaults = (): void => {
  const fileValues = readEnvValues()

  for (const key of DB_ENV_KEYS) {
    if (process.env[key]) {
      continue
    }
    const fileValue = fileValues[key]
    if (fileValue) {
      process.env[key] = unquoteEnvValue(fileValue)
    }
  }
}

const UNREACHABLE_DB_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  '28P01',
  '3D000',
])

const UNREACHABLE_DB_MESSAGE =
  /connect ECONNREFUSED|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|connect ETIMEDOUT|connect ECONNRESET|timeout acquiring a connection|the pool is probably full|password authentication failed|database ".*" does not exist/i

const walkErrorChain = (error: unknown): Array<{ code?: string; message?: string }> => {
  const items: Array<{ code?: string; message?: string }> = []
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const err = current as { code?: string; message?: string; cause?: unknown; original?: unknown }
    items.push({ code: err.code, message: err.message })
    current = err.cause ?? err.original
  }

  return items
}

const isUnreachableDbError = (error: unknown): boolean =>
  walkErrorChain(error).some(
    ({ code, message }) =>
      (code !== undefined && UNREACHABLE_DB_CODES.has(code)) ||
      (typeof message === 'string' && UNREACHABLE_DB_MESSAGE.test(message)),
  )

export const openInviteDbClient = (): DatabaseClient => {
  applyDbEnvFileDefaults()

  if (!process.env.DB_URI && !process.env.DB_HOST) {
    throw new Error(`PostgreSQL is not configured (set DB_URI or DB_HOST).\n\n${INVITE_CLI_DB_HINT}`)
  }

  return knex({
    client: 'pg',
    connection: process.env.DB_URI
      ? process.env.DB_URI
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        },
    pool: {
      min: 0,
      max: 1,
      idleTimeoutMillis: 1000,
      acquireTimeoutMillis: CLI_DB_ACQUIRE_TIMEOUT_MS,
      propagateCreateError: true,
    },
    acquireConnectionTimeout: CLI_DB_ACQUIRE_TIMEOUT_MS,
  } as Knex.Config)
}

const serializeInviteCode = (invite: InviteCode) => ({
  code: invite.code,
  createdBy: invite.createdBy,
  claimedBy: invite.claimedBy,
  expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
  remainingUses: invite.remainingUses,
  createdAt: invite.createdAt.toISOString(),
  updatedAt: invite.updatedAt.toISOString(),
})

export const runInviteCreate = async (
  options: InviteCreateOptions,
  deps: InviteCreateDependencies = {},
): Promise<number> => {
  const loadSettings = deps.loadSettings ?? loadMergedSettings
  const issue = deps.issue ?? issueInviteCode
  const now = deps.now ?? Date.now
  const settings = loadSettings()

  const overrides: Parameters<typeof issueInviteCode>[2] = {}
  if (typeof options.uses === 'number') {
    overrides.remainingUses = options.uses
  }
  if (typeof options.expiresIn === 'number') {
    overrides.expiresAt = new Date(now() + options.expiresIn * 1000)
  }
  const createdBy = parseRelayPubkey(settings.info?.self)
  if (createdBy) {
    overrides.createdBy = createdBy
  }

  let dbClient: DatabaseClient | undefined
  try {
    dbClient = deps.createDbClient ? deps.createDbClient() : openInviteDbClient()
    const repository = deps.createRepository ? deps.createRepository(dbClient) : new InviteCodeRepository(dbClient)

    const invite = await issue(repository, settings.nip43, overrides)

    if (options.json) {
      logInfo(JSON.stringify(serializeInviteCode(invite)))
    } else {
      logInfo(invite.code)
      logInfo(`uses: ${invite.remainingUses ?? 'unlimited'}`)
      logInfo(`expires: ${invite.expiresAt ? invite.expiresAt.toISOString() : 'never'}`)
    }

    return 0
  } catch (error) {
    if (isUnreachableDbError(error)) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message}\n\n${INVITE_CLI_DB_HINT}`)
    }
    throw error
  } finally {
    if (dbClient && typeof (dbClient as Knex).destroy === 'function') {
      await (dbClient as Knex).destroy()
    }
  }
}
