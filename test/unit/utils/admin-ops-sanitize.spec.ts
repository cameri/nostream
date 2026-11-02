import { expect } from 'chai'

import { sanitizeAdminOpsError } from '../../../src/utils/admin-ops-sanitize'

describe('sanitizeAdminOpsError', () => {
  it('redacts urls and truncates long messages', () => {
    const message = `failed wss://secret.relay.example/nostr Bearer token123 ${'x'.repeat(300)}`
    const sanitized = sanitizeAdminOpsError(message)

    expect(sanitized).to.include('[url]')
    expect(sanitized).to.include('Bearer [redacted]')
    expect(sanitized!.length).to.be.at.most(241)
  })

  it('returns undefined for empty input', () => {
    expect(sanitizeAdminOpsError(undefined)).to.equal(undefined)
    expect(sanitizeAdminOpsError('   ')).to.equal(undefined)
  })
})
