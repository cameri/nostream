import { expect } from 'chai'

import {
  createReadAuthorizationGuard,
  DEFAULT_RESTRICTED_READ_KINDS,
  getRestrictedReadKinds,
  isClientAuthorizedToReadEvent,
  isCountAuthorized,
  isSubscriptionAuthRequired,
} from '../../../src/utils/nip42'
import { Event } from '../../../src/@types/event'
import { Settings } from '../../../src/@types/settings'
import { SubscriptionFilter } from '../../../src/@types/subscription'

const author = 'a'.repeat(64)
const recipient = 'b'.repeat(64)
const stranger = 'c'.repeat(64)

const makeEvent = (kind: number, tags: string[][] = []): Event =>
  ({
    id: 'e'.repeat(64),
    pubkey: author,
    created_at: 1665546189,
    kind,
    tags,
    content: '',
    sig: 'f'.repeat(128),
  }) as Event

const enabledSettings = (kinds?: (number | [number, number])[]): Settings =>
  ({
    nip42: {
      restrictedReads: {
        enabled: true,
        ...(kinds ? { kinds } : {}),
      },
    },
  }) as unknown as Settings

describe('nip42', () => {
  describe('getRestrictedReadKinds', () => {
    it('returns empty array when settings are undefined', () => {
      expect(getRestrictedReadKinds(undefined)).to.deep.equal([])
    })

    it('returns empty array when restrictedReads is disabled', () => {
      const settings = {
        nip42: { restrictedReads: { enabled: false, kinds: [4] } },
      } as unknown as Settings

      expect(getRestrictedReadKinds(settings)).to.deep.equal([])
    })

    it('returns configured kinds when enabled', () => {
      expect(getRestrictedReadKinds(enabledSettings([4, [1059, 1060]]))).to.deep.equal([4, [1059, 1060]])
    })

    it('returns default kinds when enabled without explicit kinds', () => {
      expect(getRestrictedReadKinds(enabledSettings())).to.deep.equal(DEFAULT_RESTRICTED_READ_KINDS)
    })
  })

  describe('isClientAuthorizedToReadEvent', () => {
    it('returns false when no pubkeys are authenticated', () => {
      expect(isClientAuthorizedToReadEvent(makeEvent(4, [['p', recipient]]), new Set())).to.be.false
    })

    it('returns true for the event author', () => {
      expect(isClientAuthorizedToReadEvent(makeEvent(4, [['p', recipient]]), new Set([author]))).to.be.true
    })

    it('returns true for a p-tagged recipient', () => {
      expect(isClientAuthorizedToReadEvent(makeEvent(4, [['p', recipient]]), new Set([recipient]))).to.be.true
    })

    it('returns false for an unrelated authenticated pubkey', () => {
      expect(isClientAuthorizedToReadEvent(makeEvent(4, [['p', recipient]]), new Set([stranger]))).to.be.false
    })
  })

  describe('createReadAuthorizationGuard', () => {
    it('allows everything when the feature is disabled', () => {
      const guard = createReadAuthorizationGuard(undefined, () => {
        throw new Error('must not be called when disabled')
      })

      expect(guard(makeEvent(4, [['p', recipient]]))).to.be.true
    })

    it('allows unrestricted kinds without consulting authentication', () => {
      const guard = createReadAuthorizationGuard(enabledSettings(), () => {
        throw new Error('must not be called for unrestricted kinds')
      })

      expect(guard(makeEvent(1))).to.be.true
    })

    it('blocks restricted kinds for unauthenticated clients', () => {
      const guard = createReadAuthorizationGuard(enabledSettings(), () => new Set())

      expect(guard(makeEvent(1059, [['p', recipient]]))).to.be.false
    })

    it('allows restricted kinds for the tagged recipient', () => {
      const guard = createReadAuthorizationGuard(enabledSettings(), () => new Set([recipient]))

      expect(guard(makeEvent(1059, [['p', recipient]]))).to.be.true
    })

    it('supports kind ranges', () => {
      const guard = createReadAuthorizationGuard(enabledSettings([[1050, 1100]]), () => new Set())

      expect(guard(makeEvent(1059))).to.be.false
      expect(guard(makeEvent(1101))).to.be.true
    })
  })

  describe('isSubscriptionAuthRequired', () => {
    const unauthenticated = () => new Set<string>()

    it('returns false when the feature is disabled', () => {
      expect(isSubscriptionAuthRequired(undefined, [{ kinds: [4] }], unauthenticated)).to.be.false
    })

    it('returns true when every filter exclusively targets restricted kinds', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [4] }, { kinds: [1059], '#p': [recipient] }]

      expect(isSubscriptionAuthRequired(enabledSettings(), filters, unauthenticated)).to.be.true
    })

    it('returns false when any filter includes an unrestricted kind', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [1, 1059] }]

      expect(isSubscriptionAuthRequired(enabledSettings(), filters, unauthenticated)).to.be.false
    })

    it('returns false for filters without kinds', () => {
      expect(isSubscriptionAuthRequired(enabledSettings(), [{}], unauthenticated)).to.be.false
    })

    it('returns false when the client is authenticated', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [4] }]

      expect(isSubscriptionAuthRequired(enabledSettings(), filters, () => new Set([recipient]))).to.be.false
    })
  })

  describe('isCountAuthorized', () => {
    it('returns true when the feature is disabled', () => {
      expect(isCountAuthorized(undefined, [{ kinds: [4] }], () => new Set())).to.be.true
    })

    it('returns true when no filter targets restricted kinds', () => {
      expect(isCountAuthorized(enabledSettings(), [{ kinds: [1] }, {}], () => new Set())).to.be.true
    })

    it('returns false for unauthenticated restricted-kind counts', () => {
      expect(isCountAuthorized(enabledSettings(), [{ kinds: [1059], '#p': [recipient] }], () => new Set())).to.be.false
    })

    it('returns false when scoped to somebody else', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [1059], '#p': [recipient] }]

      expect(isCountAuthorized(enabledSettings(), filters, () => new Set([stranger]))).to.be.false
    })

    it('returns true when #p is scoped to the authenticated client', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [1059], '#p': [recipient] }]

      expect(isCountAuthorized(enabledSettings(), filters, () => new Set([recipient]))).to.be.true
    })

    it('returns true when authors are scoped to the authenticated client', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [4], authors: [author] }]

      expect(isCountAuthorized(enabledSettings(), filters, () => new Set([author]))).to.be.true
    })

    it('returns false for unscoped restricted-kind counts even when authenticated', () => {
      const filters: SubscriptionFilter[] = [{ kinds: [4] }]

      expect(isCountAuthorized(enabledSettings(), filters, () => new Set([author]))).to.be.false
    })
  })
})
