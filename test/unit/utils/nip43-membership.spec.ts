import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as eventUtils from '../../../src/utils/event'
import { buildMembershipListEvent, MAX_MEMBERSHIP_LIST_ENTRIES, MembershipListPublisher } from '../../../src/utils/nip43-membership'
import { EventKinds } from '../../../src/constants/base'
import { Settings } from '../../../src/@types/settings'
import { WebSocketAdapterEvent } from '../../../src/constants/adapter'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

const relayPrivkey = '1'.repeat(64)
const relayPubkey = eventUtils.getPublicKey(relayPrivkey)
const memberA = 'a'.repeat(64)
const memberB = 'b'.repeat(64)

describe('NIP-43 membership list', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('buildMembershipListEvent', () => {
    it('builds a kind 13534 event signed by the relay key with a protected tag and one member tag per pubkey', async () => {
      const event = await buildMembershipListEvent(relayPrivkey, relayPubkey, [memberA, memberB], 1_700_000_000)

      expect(event.kind).to.equal(EventKinds.NIP43_MEMBERSHIP_LIST)
      expect(event.kind).to.equal(13534)
      expect(event.pubkey).to.equal(relayPubkey)
      expect(event.created_at).to.equal(1_700_000_000)
      expect(event.content).to.equal('')
      expect(event.tags).to.deep.equal([['-'], ['member', memberA], ['member', memberB]])
    })

    it('produces an event with a valid id and signature', async () => {
      const event = await buildMembershipListEvent(relayPrivkey, relayPubkey, [memberA], 1_700_000_000)

      expect(await eventUtils.isEventIdValid(event)).to.equal(true)
      expect(await eventUtils.isEventSignatureValid(event)).to.equal(true)
    })

    it('builds an empty list when there are no members', async () => {
      const event = await buildMembershipListEvent(relayPrivkey, relayPubkey, [], 1_700_000_000)

      expect(event.tags).to.deep.equal([['-']])
    })
  })

  describe('MembershipListPublisher', () => {
    let settings: Settings
    let findAdmittedPubkeys: Sinon.SinonStub
    let findStoredReplaceable: Sinon.SinonStub
    let upsert: Sinon.SinonStub
    let emit: Sinon.SinonStub
    let publisher: MembershipListPublisher
    const NOW = 1_800_000_000

    beforeEach(() => {
      sandbox.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] })
      sandbox.stub(eventUtils, 'getRelayPrivateKey').returns(relayPrivkey)
      settings = {
        info: { relay_url: 'wss://relay.example.com' },
        nip43: { enabled: true, publishMembershipList: true },
      } as any
      findAdmittedPubkeys = sandbox.stub().resolves([memberA, memberB])
      findStoredReplaceable = sandbox.stub().resolves([])
      upsert = sandbox.stub().resolves(1)
      emit = sandbox.stub()
      publisher = new MembershipListPublisher(
        () => settings,
        { findAdmittedPubkeys } as any,
        { findStoredReplaceable, upsert } as any,
        { emit } as any,
      )
    })

    it('publishes the list of admitted members and broadcasts it', async () => {
      await publisher.refresh()

      expect(upsert).to.have.been.calledOnce
      const event = upsert.firstCall.args[0]
      expect(event.kind).to.equal(13534)
      expect(event.pubkey).to.equal(relayPubkey)
      expect(event.tags).to.deep.equal([['-'], ['member', memberA], ['member', memberB]])
      expect(event.created_at).to.equal(NOW)
      expect(emit).to.have.been.calledOnceWithExactly(WebSocketAdapterEvent.Broadcast, event)
    })

    it('does nothing by default, when publishMembershipList is not set', async () => {
      settings.nip43!.publishMembershipList = undefined

      await publisher.refresh()

      expect(findAdmittedPubkeys).not.to.have.been.called
      expect(upsert).not.to.have.been.called
    })

    it('does nothing when it is switched off', async () => {
      settings.nip43!.publishMembershipList = false

      await publisher.refresh()

      expect(upsert).not.to.have.been.called
    })

    it('does nothing when NIP-43 is disabled', async () => {
      settings.nip43!.enabled = false

      await publisher.refresh()

      expect(upsert).not.to.have.been.called
    })

    it('does not publish when info.self is not the relay signing pubkey', async () => {
      settings.info!.self = 'c'.repeat(64)

      await publisher.refresh()

      expect(upsert).not.to.have.been.called
    })

    it('publishes when info.self is the relay signing pubkey', async () => {
      settings.info!.self = relayPubkey

      await publisher.refresh()

      expect(upsert).to.have.been.calledOnce
    })

    it('does not publish when info.self is a malformed npub', async () => {
      settings.info!.self = 'npub1notvalid'

      await publisher.refresh()

      expect(upsert).not.to.have.been.called
    })

    it('uses a created_at later than the stored list, so a refresh in the same second still replaces it', async () => {
      findStoredReplaceable.resolves([{ event_created_at: NOW, event_id: Buffer.alloc(32) }])

      await publisher.refresh()

      expect(findStoredReplaceable).to.have.been.calledOnceWithExactly(relayPubkey, 13534)
      expect(upsert.firstCall.args[0].created_at).to.equal(NOW + 1)
    })

    it('uses the current time when the stored list is older', async () => {
      findStoredReplaceable.resolves([{ event_created_at: NOW - 500, event_id: Buffer.alloc(32) }])

      await publisher.refresh()

      expect(upsert.firstCall.args[0].created_at).to.equal(NOW)
    })

    it('does not broadcast when the list was not stored', async () => {
      upsert.resolves(0)

      await publisher.refresh()

      expect(emit).not.to.have.been.called
    })

    it('cuts the list at the maximum number of entries', async () => {
      findAdmittedPubkeys.resolves(
        Array.from({ length: MAX_MEMBERSHIP_LIST_ENTRIES + 1 }, (_, i) => i.toString(16).padStart(64, '0')),
      )

      await publisher.refresh()

      expect(findAdmittedPubkeys).to.have.been.calledOnceWithExactly(MAX_MEMBERSHIP_LIST_ENTRIES + 1)
      expect(upsert.firstCall.args[0].tags).to.have.length(MAX_MEMBERSHIP_LIST_ENTRIES + 1)
    })

    it('rejects when the list cannot be stored, so the caller can log it', async () => {
      upsert.rejects(new Error('db down'))

      await expect(publisher.refresh()).to.be.rejectedWith('db down')
    })

    it('keeps working after a failed refresh', async () => {
      upsert.onFirstCall().rejects(new Error('db down'))

      await publisher.refresh().catch(() => undefined)
      await publisher.refresh()

      expect(upsert).to.have.been.calledTwice
    })

    it('publishes refreshes one after the other, in the order they were asked for', async () => {
      const order: string[] = []
      let releaseFirst!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      findAdmittedPubkeys.onFirstCall().callsFake(async () => {
        order.push('first-start')
        await gate
        order.push('first-end')
        return [memberA]
      })
      findAdmittedPubkeys.onSecondCall().callsFake(async () => {
        order.push('second-start')
        return [memberA, memberB]
      })

      const first = publisher.refresh()
      const second = publisher.refresh()
      await new Promise((resolve) => setImmediate(resolve))
      expect(order).to.deep.equal(['first-start'])
      releaseFirst()
      await Promise.all([first, second])

      expect(order).to.deep.equal(['first-start', 'first-end', 'second-start'])
      expect(upsert.firstCall.args[0].tags).to.have.length(2)
      expect(upsert.secondCall.args[0].tags).to.have.length(3)
    })
  })
})
