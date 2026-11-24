import type { IWebSocketAdapter } from '../../@types/adapters'
import type { Event } from '../../@types/event'
import type { PeeringAttestation } from '../../@types/peering'
import type { IEventStrategy } from '../../@types/message-handlers'
import type { IPeeringAttestationRepository } from '../../@types/repositories'
import type { Settings } from '../../@types/settings'
import { WebSocketAdapterEvent } from '../../constants/adapter'
import { createEventCommandResult } from '../../telemetry/event-metrics'
import { createLogger } from '../../factories/logger-factory'
import { getPublicKey, getRelayPrivateKey } from '../../utils/event'
import { findConfiguredPeeringPeer } from '../../utils/peering-auth'
import { resolveRelaySelfPubkey } from '../../utils/nip43'
import {
  buildPeeringAcceptanceEvent,
  parsePeeringRequestPayload,
  verifyPeeringRequestEvent,
} from '../../utils/peering-attestation'
import { createOutgoingEventMessage } from '../../utils/messages'

const logger = createLogger('peering-request-event-strategy')

/**
 * Owner-signed request presented once over the relay's authenticated peer
 * socket. The owner key signs the establishment record; the relay key is the
 * live proof on the connection. Only configured peers are accepted in v1.
 */
export class PeeringRequestEventStrategy implements IEventStrategy<Event, Promise<void>> {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly settings: () => Settings,
    private readonly attestations?: IPeeringAttestationRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly relayPrivateKey?: () => string,
  ) {}

  public async execute(event: Event): Promise<void> {
    const settings = this.settings()
    const peering = settings.peering

    if (peering?.enabled !== true) {
      this.reject(event, 'restricted: peering is not enabled on this relay')
      return
    }

    const payload = parsePeeringRequestPayload(event)
    if (!payload) {
      this.reject(event, 'invalid: malformed peering request payload')
      return
    }

    const configured = findConfiguredPeeringPeer(settings, payload.relay_pubkey)
    if (!configured) {
      logger('rejecting peering request from unconfigured relay %s', payload.relay_pubkey)
      this.reject(event, 'restricted: this relay only peers with configured relay pubkeys')
      return
    }

    const relayPrivateKey = this.relayPrivateKey?.() ?? getRelayPrivateKey(settings.info.relay_url)
    const receiverPubkey = (resolveRelaySelfPubkey(settings) ?? getPublicKey(relayPrivateKey)).toLowerCase()
    const verified = await verifyPeeringRequestEvent(event, {
      authenticatedPubkeys: this.webSocket.getAuthenticatedPubkeys(),
      receiverPubkey,
      offeredScopes: peering.scopes ?? [],
      offeredTerms: peering.terms ?? [],
      minPowDifficulty: peering.minRequestPowDifficulty ?? 0,
      isConfiguredPeer: true,
      waivePowForConfiguredPeers: peering.waiveRequestPowForConfiguredPeers,
      expectedOwnerPubkey: configured.ownerPubkey,
      now: this.now(),
    })

    if (verified.ok === false) {
      logger('rejecting peering request from %s: %s', payload.relay_pubkey, verified.reason)
      this.reject(event, verified.reason)
      return
    }

    const acceptedAt = this.now()
    const attestation: PeeringAttestation = {
      relayPubkey: verified.request.relay_pubkey,
      ownerPubkey: event.pubkey,
      relayUrl: verified.request.relay_url,
      requestEventId: event.id,
      scopes: verified.request.scopes,
      terms: verified.request.terms,
      termsHash: verified.request.terms_hash,
      powDifficulty: verified.powDifficulty,
      acceptedAt,
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
    }

    if (!this.attestations) {
      this.reject(event, 'error: peering attestations are unavailable')
      return
    }

    try {
      await this.attestations.save(attestation)
    } catch (error) {
      logger('unable to store peering attestation for %s: %o', payload.relay_pubkey, error)
      this.reject(event, 'error: unable to record peering attestation')
      return
    }

    // A required-attestation relay withheld peer treatment at AUTH; the valid
    // request is what unlocks it for this session.
    this.webSocket.setPeerPubkey(verified.request.relay_pubkey, {
      termsHash: verified.request.terms_hash,
      scopes: verified.request.scopes,
      ownerPubkey: event.pubkey,
    })

    try {
      const acceptance = await buildPeeringAcceptanceEvent({
        request: event,
        acceptance: verified.request,
        relayPrivateKey,
        relayUrl: settings.info.relay_url,
        createdAt: Math.floor(acceptedAt.getTime() / 1000),
      })
      this.webSocket.emit(WebSocketAdapterEvent.Message, createOutgoingEventMessage('peering-acceptance', acceptance))
    } catch (error) {
      // The record is stored; a failed reply can be retried by the peer.
      logger('unable to send peering acceptance for %s: %o', payload.relay_pubkey, error)
    }

    logger('accepted peering attestation from %s for relay %s', event.pubkey, payload.relay_pubkey)
    this.webSocket.emit(
      WebSocketAdapterEvent.Message,
      createEventCommandResult(event.id, true, 'info: peering request accepted'),
    )
  }

  private reject(event: Event, reason: string): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, createEventCommandResult(event.id, false, reason))
  }
}
