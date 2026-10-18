import { Nip05Verification } from '../@types/nip05'
import { AdminNip05VerificationAdminRow } from '../@types/admin-ops'
import { DEFAULT_NIP05_VERIFY_EXPIRATION_MS } from './nip05'
import { Settings } from '../@types/settings'

export const getNip05VerifyExpirationMs = (settings: Settings): number =>
  settings.nip05?.verifyExpiration ?? DEFAULT_NIP05_VERIFY_EXPIRATION_MS

export const isNip05VerificationStale = (
  verification: Pick<Nip05Verification, 'isVerified' | 'lastVerifiedAt'>,
  verifyExpirationMs: number,
  now = Date.now(),
): boolean => {
  if (!verification.isVerified || !verification.lastVerifiedAt) {
    return true
  }
  return now - verification.lastVerifiedAt.getTime() > verifyExpirationMs
}

export const toAdminNip05Row = (
  verification: Nip05Verification,
  verifyExpirationMs: number,
): AdminNip05VerificationAdminRow => ({
  pubkey: verification.pubkey,
  nip05: verification.nip05,
  domain: verification.domain,
  isVerified: verification.isVerified,
  failureCount: verification.failureCount,
  lastVerifiedAt: verification.lastVerifiedAt ? verification.lastVerifiedAt.toISOString() : null,
  lastCheckedAt: verification.lastCheckedAt.toISOString(),
  stale: isNip05VerificationStale(verification, verifyExpirationMs),
})
