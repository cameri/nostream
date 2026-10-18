import { INip05VerificationRepository } from '../@types/repositories'
import { Nip05Verification } from '../@types/nip05'
import { applyReverificationOutcome } from '../app/maintenance-worker'
import { verifyNip05Identifier } from './nip05'

export const reverifyNip05Verification = async (
  verification: Nip05Verification,
  repository: INip05VerificationRepository,
): Promise<Nip05Verification> => {
  const outcome = await verifyNip05Identifier(verification.nip05, verification.pubkey)
  const updated = applyReverificationOutcome(verification, outcome)
  await repository.upsert(updated)
  return updated
}
