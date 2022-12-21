import 'pg'
import 'pg-query-stream'
import knex, { Knex } from 'knex'
import { createLogger } from '../factories/logger-factory'

const debug = createLogger('database-client')

const createDbConfig = (): Knex.Config => ({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  pool: {
    min: process.env.DB_MIN_POOL_SIZE ? Number(process.env.DB_MIN_POOL_SIZE) : 0,
    max: process.env.DB_MAX_POOL_SIZE ? Number(process.env.DB_MAX_POOL_SIZE) : 3,
    idleTimeoutMillis: 10000,
  },
  acquireConnectionTimeout: 2000,
})

let client: Knex

export const getDbClient = () => {
  if (!client) {
    const config = createDbConfig()
    debug('config: %o', config)
    client = knex(config)
  }

  return client
}
