/**
 * Fallback when the processor reports no expiry. Generous on purpose: LNURL and NWC
 * have no callback, so retiring an invoice that is still payable loses the payment,
 * while erring long just leaves the row around a bit.
 */
export const DEFAULT_INVOICE_EXPIRY_SECONDS = 86400

/** Cap on the configured fallback. An over-long value is the bug this prevents. */
export const MAX_INVOICE_EXPIRY_SECONDS = 30 * 86400

export const isExpiredInvoice = (invoice: { expiresAt?: Date | null }): boolean =>
  invoice.expiresAt instanceof Date && invoice.expiresAt.getTime() <= Date.now()

const isUsableDate = (value: unknown): value is Date => value instanceof Date && !Number.isNaN(value.getTime())

export const resolveInvoiceExpirySeconds = (configured: unknown): number => {
  if (typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0) {
    return Math.min(configured, MAX_INVOICE_EXPIRY_SECONDS)
  }

  return DEFAULT_INVOICE_EXPIRY_SECONDS
}

/**
 * Every invoice needs an expiry. `isExpiredInvoice` is false for null and for an
 * unparseable date, so without one the row can never be retired.
 */
export const resolveInvoiceExpiry = (
  processorExpiry: Date | null | undefined,
  createdAt: Date,
  expirySeconds: number = DEFAULT_INVOICE_EXPIRY_SECONDS,
): Date => {
  if (isUsableDate(processorExpiry)) {
    return processorExpiry
  }

  const base = isUsableDate(createdAt) ? createdAt : new Date()

  return new Date(base.getTime() + resolveInvoiceExpirySeconds(expirySeconds) * 1000)
}
