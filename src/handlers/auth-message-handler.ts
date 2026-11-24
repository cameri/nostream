import { EventKinds, EventTags } from '../constants/base'
import { isEventIdValid, isEventSignatureValid } from '../utils/event'
import { AuthMessage } from '../@types/messages'
import { createCommandResult } from '../utils/messages'
import { createLogger } from '../factories/logger-factory'
import { IMessageHandler } from '../@types/message-handlers'
import { IWebSocketAdapter } from '../@types/adapters'
import type { IPeeringAttestationRepository } from '../@types/repositories'
import { Settings } from '../@types/settings'
import { WebSocketAdapterEvent } from '../constants/adapter'
import { findConfiguredPeeringPeer, isConfiguredPeeringPeer, parsePeeringPeerPubkey } from '../utils/peering-auth'
import { peeringTermsHash, samePeeringScopes } from '../utils/peering-attestation'

const logger = createLogger('auth-message-handler')

const AUTH_EVENT_KIND = EventKinds.AUTH // 22242
const MAX_TIMESTAMP_DELTA_SECONDS = 600 // 10 minutes

export class AuthMessageHandler implements IMessageHandler {
  public constructor(
    private readonly webSocket: IWebSocketAdapter,
    private readonly settings: () => Settings,
    private readonly peeringAttestations?: IPeeringAttestationRepository,
  ) {}

  public async handleMessage(message: AuthMessage): Promise<void> {
    const event = message[1]

    if (event.kind !== AUTH_EVENT_KIND) {
      this.sendResult(event.id, false, 'invalid: auth event must be kind 22242')
      return
    }

    if (!(await isEventIdValid(event))) {
      this.sendResult(event.id, false, 'invalid: event id does not match')
      return
    }

    if (!(await isEventSignatureValid(event))) {
      this.sendResult(event.id, false, 'invalid: event signature verification failed')
      return
    }

    const now = Math.floor(Date.now() / 1000)
    const delta = Math.abs(now - event.created_at)
    if (delta > MAX_TIMESTAMP_DELTA_SECONDS) {
      this.sendResult(event.id, false, 'invalid: created_at is too far from the current time')
      return
    }

    const challengeTag = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.Challenge)
    if (!challengeTag || challengeTag[1] !== this.webSocket.getChallenge()) {
      this.sendResult(event.id, false, 'invalid: challenge does not match')
      return
    }

    const relayTag = event.tags.find((tag) => tag.length >= 2 && tag[0] === EventTags.AuthRelay)
    const relayUrl = this.settings().info.relay_url
    if (!relayTag || !this.isRelayUrlMatch(relayTag[1], relayUrl)) {
      this.sendResult(event.id, false, 'invalid: relay url does not match')
      return
    }

    logger('client %s authenticated as %s', this.webSocket.getClientId(), event.pubkey)
    if (!this.webSocket.addAuthenticatedPubkey(event.pubkey, event.id)) {
      this.sendResult(event.id, false, 'invalid: auth event already used')
      return
    }

    // Peer identity is a verified AUTH from a configured pubkey, never a URL
    // or a self-declared key. Unconfigured pubkeys stay ordinary clients.
    if (isConfiguredPeeringPeer(this.settings(), event.pubkey)) {
      await this.applyOwnerAttestationPolicy(event.pubkey)
    }

    this.sendResult(event.id, true, '')
  }

  /**
   * `required` withholds peer treatment until an accepted owner-signed request
   * exists for this relay key. A request sent after AUTH unlocks the session;
   * a failed lookup fails closed.
   */
  private async applyOwnerAttestationPolicy(pubkey: string): Promise<void> {
    const policy = this.settings().peering?.ownerAttestation ?? 'waived'
    if (policy !== 'required') {
      this.webSocket.setPeerPubkey(pubkey)
      return
    }

    const withhold = (): void => {
      // A re-AUTH must not leave an earlier peer identity alive after the
      // agreement stops matching.
      this.webSocket.clearPeerPubkey(pubkey)
    }

    if (!this.peeringAttestations) {
      logger('peer %s authenticated but no attestation store is available', pubkey)
      withhold()
      return
    }

    try {
      const attestation = await this.peeringAttestations.findByRelayPubkey(pubkey)
      if (attestation) {
        // Terms and scopes are part of the agreement. A material change needs
        // a fresh owner signature before peer treatment resumes.
        const currentTerms = this.settings().peering?.terms ?? []
        const currentScopes = this.settings().peering?.scopes ?? []
        const configuredOwnerRaw = findConfiguredPeeringPeer(this.settings(), pubkey)?.ownerPubkey
        const configuredOwner = configuredOwnerRaw ? parsePeeringPeerPubkey(configuredOwnerRaw) : undefined
        const ownerMatches =
          !configuredOwnerRaw ||
          (configuredOwner !== undefined && attestation.ownerPubkey?.toLowerCase() === configuredOwner)
        if (
          ownerMatches &&
          attestation.termsHash?.toLowerCase() === peeringTermsHash(currentTerms) &&
          samePeeringScopes(attestation.scopes ?? [], currentScopes)
        ) {
          this.webSocket.setPeerPubkey(pubkey, {
            termsHash: attestation.termsHash,
            scopes: attestation.scopes ?? [],
            ownerPubkey: attestation.ownerPubkey,
          })
          return
        }
        logger('peer %s attestation no longer matches the advertised terms or scopes', pubkey)
        withhold()
        return
      }
    } catch (error) {
      logger('unable to read peering attestation for %s: %o', pubkey, error)
      withhold()
      return
    }

    logger('peer %s authenticated but has no accepted owner attestation', pubkey)
    withhold()
  }

  private sendResult(eventId: string, success: boolean, message: string): void {
    this.webSocket.emit(WebSocketAdapterEvent.Message, createCommandResult(eventId, success, message))
  }

  // NIP-42 says domain-match is sufficient for relay URL comparison
  private isRelayUrlMatch(clientRelay: string, serverRelay: string): boolean {
    try {
      const clientHost = new URL(clientRelay).hostname.toLowerCase()
      const serverHost = new URL(serverRelay).hostname.toLowerCase()
      return clientHost === serverHost
    } catch {
      return false
    }
  }
}
