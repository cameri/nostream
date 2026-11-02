import { expect } from 'chai'

import { isNip05VerificationStale, toAdminNip05Row } from '../../../src/utils/admin-ops-nip05'

describe('admin-ops-nip05', () => {
  it('marks unverified rows as stale', () => {
    const row = toAdminNip05Row(
      {
        pubkey: 'aa'.repeat(32),
        nip05: 'user@example.com',
        domain: 'example.com',
        isVerified: false,
        failureCount: 2,
        lastVerifiedAt: null,
        lastCheckedAt: new Date('2020-01-01T00:00:00.000Z'),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
        updatedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
      86_400_000,
    )

    expect(row.stale).to.equal(true)
  })

  it('treats recently verified rows as fresh', () => {
    const now = Date.now()
    expect(
      isNip05VerificationStale(
        { isVerified: true, lastVerifiedAt: new Date(now - 1000) },
        86_400_000,
        now,
      ),
    ).to.equal(false)
  })
})
