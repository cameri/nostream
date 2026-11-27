/**
 * PostgreSQL aborts the losing transaction with SQLSTATE 40001 when two
 * serializable transactions conflict. Knex and pg can wrap the original error,
 * so walk the usual `original`/`cause` chain.
 */
export const isSerializationFailure = (error: unknown): boolean => {
  const seen = new Set<unknown>()
  let current: unknown = error

  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const candidate = current as { code?: unknown; original?: unknown; cause?: unknown }
    if (candidate.code === '40001' || candidate.code === 40001) {
      return true
    }
    current = candidate.original ?? candidate.cause
  }

  return false
}
