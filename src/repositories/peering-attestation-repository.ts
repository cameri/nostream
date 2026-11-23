import { DatabaseClient, Pubkey } from '../@types/base'
import type { DBPeeringAttestation, PeeringAttestation } from '../@types/peering'
import type { IPeeringAttestationRepository } from '../@types/repositories'
import { fromBuffer, toBuffer } from '../utils/transform'

const fromRow = (row: DBPeeringAttestation): PeeringAttestation => ({
  relayPubkey: fromBuffer(row.relay_pubkey),
  ownerPubkey: fromBuffer(row.owner_pubkey),
  relayUrl: row.relay_url,
  requestEventId: row.request_event_id,
  scopes: row.scopes as PeeringAttestation['scopes'],
  terms: row.terms as PeeringAttestation['terms'],
  termsHash: row.terms_hash,
  powDifficulty: row.pow_difficulty,
  acceptedAt: row.accepted_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class PeeringAttestationRepository implements IPeeringAttestationRepository {
  public constructor(private readonly dbClient: DatabaseClient) {}

  public async findByRelayPubkey(
    pubkey: Pubkey,
    client: DatabaseClient = this.dbClient,
  ): Promise<PeeringAttestation | undefined> {
    const row = await client<DBPeeringAttestation>('peering_attestations')
      .where({ relay_pubkey: toBuffer(pubkey) })
      .first()

    return row ? fromRow(row) : undefined
  }

  public async save(
    attestation: PeeringAttestation,
    client: DatabaseClient = this.dbClient,
  ): Promise<PeeringAttestation> {
    const now = new Date()
    const [row] = await client<DBPeeringAttestation>('peering_attestations')
      .insert({
        relay_pubkey: toBuffer(attestation.relayPubkey),
        owner_pubkey: toBuffer(attestation.ownerPubkey),
        relay_url: attestation.relayUrl,
        request_event_id: attestation.requestEventId,
        scopes: JSON.stringify(attestation.scopes),
        terms: JSON.stringify(attestation.terms),
        terms_hash: attestation.termsHash,
        pow_difficulty: attestation.powDifficulty,
        accepted_at: attestation.acceptedAt ?? null,
        created_at: now,
        updated_at: now,
      })
      .onConflict('relay_pubkey')
      .merge({
        owner_pubkey: toBuffer(attestation.ownerPubkey),
        relay_url: attestation.relayUrl,
        request_event_id: attestation.requestEventId,
        scopes: JSON.stringify(attestation.scopes),
        terms: JSON.stringify(attestation.terms),
        terms_hash: attestation.termsHash,
        pow_difficulty: attestation.powDifficulty,
        accepted_at: attestation.acceptedAt ?? null,
        updated_at: now,
      })
      .returning('*')

    return row ? fromRow(row) : { ...attestation, createdAt: now, updatedAt: now }
  }
}
