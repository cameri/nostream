// isExpiredInvoice is false for a null expiry, so the worker never retires these
// and they sit in its polling window forever. Give the existing ones an expiry
// from their creation time so they can drain. Pending rows only.
const DEFAULT_INVOICE_EXPIRY_SECONDS = 86400

exports.up = async function (knex) {
  await knex('invoices')
    .whereNull('expires_at')
    .andWhere('status', 'pending')
    .update({
      // created_at is timestamptz, expires_at is not. Pin the conversion to UTC
      // instead of the session TimeZone.
      expires_at: knex.raw("(created_at AT TIME ZONE 'UTC') + (? || ' seconds')::interval", [
        DEFAULT_INVOICE_EXPIRY_SECONDS,
      ]),
    })
}

exports.down = async function () {
  // Not reversible: a backfilled expiry is indistinguishable from a real one.
}
