export const isExpiredInvoice = (invoice: { expiresAt?: Date | null }): boolean =>
  invoice.expiresAt instanceof Date && invoice.expiresAt.getTime() <= Date.now()
