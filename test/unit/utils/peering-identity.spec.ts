import { expect } from 'chai'

import { EventKinds, EventTags } from '../../../src/constants/base'
import { getPublicKey, isEventIdValid, isEventSignatureValid } from '../../../src/utils/event'
import {
  buildPeeringAuthEvent,
  findConfiguredPeeringPeer,
  isConfiguredPeeringPeer,
  parsePeeringPeerPubkey,
} from '../../../src/utils/peering-identity'
import { toBech32 } from '../../../src/utils/transform'

describe('peering-identity', () => {
  const privateKey = 'a'.repeat(64)
  const pubkey = getPublicKey(privateKey)
  const otherPubkey = getPublicKey('b'.repeat(64))

  const settingsWithPeers = (peers: unknown[]) =>
    ({
      peering: {
        enabled: true,
        peers,
      },
    }) as any

  describe('parsePeeringPeerPubkey', () => {
    it('normalizes hex and npub pubkeys to lowercase hex', () => {
      expect(parsePeeringPeerPubkey(pubkey)).to.equal(pubkey)
      expect(parsePeeringPeerPubkey(pubkey.toUpperCase())).to.equal(pubkey)
      expect(parsePeeringPeerPubkey(toBech32('npub')(pubkey))).to.equal(pubkey)
    })

    it('rejects values that are not a 32-byte pubkey', () => {
      expect(parsePeeringPeerPubkey('not-a-pubkey')).to.equal(undefined)
      expect(parsePeeringPeerPubkey('npub1broken')).to.equal(undefined)
      expect(parsePeeringPeerPubkey(42)).to.equal(undefined)
    })
  })

  describe('configured peer lookup', () => {
    it('recognizes an enabled configured peer by hex or npub', () => {
      const settings = settingsWithPeers([
        { pubkey: toBech32('npub')(pubkey), relayUrl: 'wss://peer.example.com', enabled: true },
      ])

      expect(isConfiguredPeeringPeer(settings, pubkey)).to.equal(true)
      expect(findConfiguredPeeringPeer(settings, pubkey)?.relayUrl).to.equal('wss://peer.example.com')
    })

    it('does not recognize disabled or unconfigured pubkeys', () => {
      const settings = settingsWithPeers([
        { pubkey, relayUrl: 'wss://peer.example.com', enabled: false },
        { pubkey: otherPubkey, relayUrl: 'wss://other.example.com' },
      ])

      expect(isConfiguredPeeringPeer(settings, pubkey)).to.equal(false)
      expect(isConfiguredPeeringPeer(settings, getPublicKey('c'.repeat(64)))).to.equal(false)
    })

    it('returns false when peering or the peer list is absent', () => {
      expect(isConfiguredPeeringPeer({} as any, pubkey)).to.equal(false)
      expect(isConfiguredPeeringPeer({ peering: { enabled: true } } as any, pubkey)).to.equal(false)
    })
  })

  describe('buildPeeringAuthEvent', () => {
    it('builds a signed kind 22242 event with relay and challenge tags', async () => {
      const event = await buildPeeringAuthEvent({
        relayUrl: 'wss://peer.example.com',
        challenge: 'challenge-value',
        privateKey,
        createdAt: 1_700_000_000,
      })

      expect(event.kind).to.equal(EventKinds.AUTH)
      expect(event.pubkey).to.equal(pubkey)
      expect(event.created_at).to.equal(1_700_000_000)
      expect(event.tags).to.deep.equal([
        [EventTags.AuthRelay, 'wss://peer.example.com'],
        [EventTags.Challenge, 'challenge-value'],
      ])
      expect(await isEventIdValid(event)).to.equal(true)
      expect(await isEventSignatureValid(event)).to.equal(true)
    })

    it('refuses to build an event without a relay URL or challenge', async () => {
      for (const options of [
        { relayUrl: '', challenge: 'challenge', privateKey },
        { relayUrl: 'wss://peer.example.com', challenge: '  ', privateKey },
      ]) {
        let error: Error | undefined
        try {
          await buildPeeringAuthEvent(options)
        } catch (err) {
          error = err as Error
        }
        expect(error).to.be.instanceOf(Error)
      }
    })
  })
})
