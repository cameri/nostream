import 'pg'
import 'pg-query-stream'
import knex, { Knex } from 'knex'
import { createLogger } from '../factories/logger-factory'

const getMasterConfig = (): Knex.Config => ({
  client: 'pg',
  connection: process.env.DB_URI ? process.env.DB_URI : {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  pool: {
    min: process.env.DB_MIN_POOL_SIZE ? Number(process.env.DB_MIN_POOL_SIZE) : 0,
    max: process.env.DB_MAX_POOL_SIZE ? Number(process.env.DB_MAX_POOL_SIZE) : 3,
    idleTimeoutMillis: 60000,
    propagateCreateError: false,
    acquireTimeoutMillis: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
    ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
    : 60000,
  },
  acquireConnectionTimeout: process.env.DB_ACQUIRE_CONNECTION_TIMEOUT
    ? Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT)
    : 60000,
})

const getReadReplicaConfig = (): Knex.Config => ({
  client: 'pg',
  connection: {
    host: process.env.RR_DB_HOST,
    port: Number(process.env.RR_DB_PORT),
    user: process.env.RR_DB_USER,
    password: process.env.RR_DB_PASSWORD,
    database: process.env.RR_DB_NAME,
  },
  pool: {
    min: process.env.RR_DB_MIN_POOL_SIZE ? Number(process.env.RR_DB_MIN_POOL_SIZE) : 0,
    max: process.env.RR_DB_MAX_POOL_SIZE ? Number(process.env.RR_DB_MAX_POOL_SIZE) : 3,
    idleTimeoutMillis: 60000,
    propagateCreateError: false,
    acquireTimeoutMillis: process.env.RR_DB_ACQUIRE_CONNECTION_TIMEOUT
    ? Number(process.env.RR_DB_ACQUIRE_CONNECTION_TIMEOUT)
    : 60000,
  },
  acquireConnectionTimeout: process.env.RR_DB_ACQUIRE_CONNECTION_TIMEOUT
    ? Number(process.env.RR_DB_ACQUIRE_CONNECTION_TIMEOUT)
    : 60000,
})

let writeClient: Knex

export const getMasterDbClient = () => {
  const debug = createLogger('database-client:get-db-client')
  if (!writeClient) {
    const config = getMasterConfig()
    debug('config: %o', config)
    writeClient = knex(config)
  }

  return writeClient
}

let readClient: Knex

export const getReadReplicaDbClient = () => {
  if (process.env.READ_REPLICA_ENABLED !== 'true') {
    return getMasterDbClient()
  }

  const debug = createLogger('database-client:get-read-replica-db-client')
  if (!readClient) {
    const config = getReadReplicaConfig()
    debug('config: %o', config)
    readClient = knex(config)
  }

  return readClient
}
