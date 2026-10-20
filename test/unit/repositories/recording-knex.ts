import knex, { Knex } from 'knex'

// knex does not export its postgres dialect, and a transaction builds its client from the dialect's prototype,
// so a subclass is the only way to answer queries for the transaction too.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClientPG = require('knex/lib/dialects/postgres')

export interface RecordedQuery {
  sql: string
  bindings: readonly unknown[]
}

/**
 * A real knex query builder on the postgres dialect that never connects: it records each statement and
 * answers it with the next result `respondWith` was given. Rows for a select, a row count for an update or delete.
 */
export const createRecordingKnex = () => {
  const queries: RecordedQuery[] = []
  const responses: unknown[] = []

  class RecordingClient extends ClientPG {
    public async acquireConnection() {
      return {}
    }

    public async releaseConnection() {
      return undefined
    }

    public _query(_connection: unknown, query: any) {
      // Transactions open and close with statements of their own; they are not part of what a test asserts on.
      if (/^\s*(begin|commit|rollback)/i.test(query.sql)) {
        query.response = { command: 'COMMIT', rows: [], rowCount: 0 }
        return Promise.resolve(query)
      }

      queries.push({ sql: query.sql, bindings: query.bindings ?? [] })

      const response = responses.length ? responses.shift() : []
      const isRows = Array.isArray(response)
      query.response = {
        command: /^\s*(update|delete|insert)/i.test(query.sql)
          ? query.sql.trim().split(' ')[0].toUpperCase()
          : 'SELECT',
        rows: isRows ? response : [],
        rowCount: isRows ? (response as unknown[]).length : response,
      }

      return Promise.resolve(query)
    }
  }

  const db = knex({ client: RecordingClient as any })

  return {
    db: db as Knex,
    queries,
    respondWith: (...results: unknown[]) => {
      responses.push(...results)
    },
  }
}
