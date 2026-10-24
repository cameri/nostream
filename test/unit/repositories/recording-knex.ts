import knex, { Knex } from 'knex'

// knex does not export its postgres dialect, and a transaction builds its client from the dialect's prototype,
// so a subclass is the only way to answer queries for the transaction too.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ClientPG = require('knex/lib/dialects/postgres')

/** The statements that ran, in order, with a transaction's opening and closing among them. */
export type RecordedStep = 'begin' | 'commit' | 'rollback' | string

export interface RecordedQuery {
  sql: string
  bindings: readonly unknown[]
}

/**
 * A real knex query builder on the postgres dialect that never connects: it records each statement and
 * answers it with the next result `respondWith` was given. Rows for a select, a row count for an update or delete,
 * or an error to fail the statement with.
 */
export const createRecordingKnex = () => {
  const queries: RecordedQuery[] = []
  const steps: RecordedStep[] = []
  // The connection each step ran on, in the same order: statements of one transaction share one.
  const stepConnections: number[] = []
  let connections = 0
  const responses: unknown[] = []

  class RecordingClient extends ClientPG {
    public async acquireConnection() {
      return { id: ++connections }
    }

    public async releaseConnection() {
      return undefined
    }

    public _query(connection: { id: number }, query: any) {
      // A transaction opens and closes with statements of its own. They are kept apart from `queries`, which
      // holds only what the code under test asked for, and recorded in `steps` to show what ran inside one.
      const boundary = /^\s*(begin|commit|rollback)/i.exec(query.sql)
      if (boundary) {
        steps.push(boundary[1].toLowerCase())
        stepConnections.push(connection.id)
        query.response = { command: 'COMMIT', rows: [], rowCount: 0 }
        return Promise.resolve(query)
      }

      queries.push({ sql: query.sql, bindings: query.bindings ?? [] })
      steps.push(query.sql.trim().split(' ')[0].toLowerCase())
      stepConnections.push(connection.id)

      const response = responses.length ? responses.shift() : []
      if (response instanceof Error) {
        return Promise.reject(response)
      }

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
    steps,
    stepConnections,
    respondWith: (...results: unknown[]) => {
      responses.push(...results)
    },
  }
}
