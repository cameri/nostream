const MAX_OPS_ERROR_LENGTH = 240

export const sanitizeAdminOpsError = (error: unknown): string | undefined => {
  if (error === undefined || error === null) {
    return undefined
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)

  const redacted = message
    .replace(/(wss?|https?):\/\/[^\s]+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .trim()

  if (!redacted) {
    return undefined
  }

  return redacted.length > MAX_OPS_ERROR_LENGTH ? `${redacted.slice(0, MAX_OPS_ERROR_LENGTH)}…` : redacted
}
