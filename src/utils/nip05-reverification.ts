import { INip05VerificationRepository } from '../@types/repositories'
import { Nip05Verification } from '../@types/nip05'
import { applyReverificationOutcome } from '../app/maintenance-worker'
import { verifyNip05Identifier } from './nip05'

export const reverifyNip05Verification = async (
  verification: Nip05Verification,
  repository: INip05VerificationRepository,
): Promise<Nip05Verification> => {
  const outcome = await verifyNip05Identifier(verification.nip05, verification.pubkey)
  const current = await repository.findByPubkey(verification.pubkey)

  if (!current) {
    return verification
  }

  if (current.nip05 !== verification.nip05) {
    return current
  }

  const updated = applyReverificationOutcome(current, outcome)
  await repository.upsert(updated)
  return updated
}
