UPDATE invoices
SET expires_at = (created_at AT TIME ZONE 'UTC') + interval '86400 seconds'
WHERE expires_at IS NULL
  AND status = 'pending';
