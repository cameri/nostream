import 'pg'
import 'pg-query-stream'
import knex, { Knex } from 'knex'

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
    min: process.env.DB_MIN_POOL_SIZE ? Number(process.env.DB_MIN_POOL_SIZE) : 2,
    max: process.env.DB_MAX_POOL_SIZE ? Number(process.env.DB_MAX_POOL_SIZE) : 3,
    idleTimeoutMillis: 10000,
  },
  acquireConnectionTimeout: 2000,
})

let client: Knex
export const getDbClient = () => {
  if (!client) {
    client = knex(createDbConfig())
  }

  return client
}
