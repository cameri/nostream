import chai from 'chai'
import chaiAsPromised from 'chai-as-promised'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'

chai.use(sinonChai)
chai.use(chaiAsPromised)
const { expect } = chai

import { GetSubscriptionStatusController } from '../../../../src/controllers/subscriptions/get-subscription-status-controller'
import { SubscriptionStatus, UserSubscription } from '../../../../src/@types/user-subscription'
import { toBech32 } from '../../../../src/utils/transform'

const PUBKEY = 'a'.repeat(64)
const DAY = 86_400_000

const baseSettings = (overrides: any = {}) => ({
  info: { name: 'Test Relay', relay_url: 'wss://relay.example.com' },
  payments: {
    enabled: true,
    subscriptionPlans: [{ id: 'basic', amount: 5000000n, intervalSeconds: 2592000, graceSeconds: 259200 }],
  },
  limits: {},
  network: { remoteIpHeader: 'x-forwarded-for' },
  ...overrides,
})

const subscription = (overrides: Partial<UserSubscription> = {}): UserSubscription => ({
  pubkey: PUBKEY,
  planId: 'basic',
  status: SubscriptionStatus.ACTIVE,
  currentPeriodStart: new Date(Date.now() - 10 * DAY),
  currentPeriodEnd: new Date(Date.now() + 20 * DAY),
  graceEndsAt: new Date(Date.now() + 23 * DAY),
  cancelAtPeriodEnd: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
})

const makeRes = (): any => ({
  status: sinon.stub().returnsThis(),
  setHeader: sinon.stub().returnsThis(),
  send: sinon.stub().returnsThis(),
})

const makeReq = (query: any = { pubkey: PUBKEY }): any => ({
  query,
  headers: {},
  connection: { remoteAddress: '1.2.3.4' },
  socket: { remoteAddress: '1.2.3.4' },
})

describe('GetSubscriptionStatusController', () => {
  let repository: { findByPubkey: sinon.SinonStub }
  let rateLimiterHit: sinon.SinonStub
  let currentSettings: any

  const makeController = () =>
    new GetSubscriptionStatusController(
      repository as any,
      () => currentSettings,
      () => ({ hit: rateLimiterHit }),
    )

  beforeEach(() => {
    repository = { findByPubkey: sinon.stub().resolves(subscription()) }
    rateLimiterHit = sinon.stub().resolves(false)
    currentSettings = baseSettings()
  })

  describe('a subscriber', () => {
    it('reports the plan, status and when the period and access end', async () => {
      const current = subscription()
      repository.findByPubkey.resolves(current)
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.setHeader).to.have.been.calledWith('content-type', 'application/json; charset=utf8')
      expect(res.send).to.have.been.calledOnceWithExactly({
        pubkey: PUBKEY,
        planId: 'basic',
        status: 'active',
        active: true,
        currentPeriodEnd: current.currentPeriodEnd!.toISOString(),
        accessEndsAt: current.graceEndsAt!.toISOString(),
      })
      expect(repository.findByPubkey).to.have.been.calledOnceWithExactly(PUBKEY)
    })

    it('is not active once the subscription expired', async () => {
      repository.findByPubkey.resolves(
        subscription({
          status: SubscriptionStatus.EXPIRED,
          currentPeriodEnd: new Date(Date.now() - 5 * DAY),
          graceEndsAt: null,
        }),
      )
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.send.firstCall.args[0]).to.include({ status: 'expired', active: false })
    })

    it('is active in the grace period, whatever the stored status says', async () => {
      repository.findByPubkey.resolves(
        subscription({
          status: SubscriptionStatus.PAST_DUE,
          currentPeriodEnd: new Date(Date.now() - DAY),
          graceEndsAt: new Date(Date.now() + 2 * DAY),
        }),
      )
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.send.firstCall.args[0]).to.include({ status: 'past_due', active: true })
    })

    it('is not active when the period and grace have passed but the sweep has not run yet', async () => {
      repository.findByPubkey.resolves(
        subscription({
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: new Date(Date.now() - 5 * DAY),
          graceEndsAt: new Date(Date.now() - DAY),
        }),
      )
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.send.firstCall.args[0].active).to.equal(false)
    })

    it('reports no end for a subscription that never ends', async () => {
      repository.findByPubkey.resolves(
        subscription({ planId: 'grandfathered', currentPeriodEnd: null, graceEndsAt: null }),
      )
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.send.firstCall.args[0]).to.include({
        planId: 'grandfathered',
        active: true,
        currentPeriodEnd: null,
        accessEndsAt: null,
      })
    })
  })

  describe('a pubkey without a subscription', () => {
    it('reports no plan and no status', async () => {
      repository.findByPubkey.resolves(undefined)
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(res.send).to.have.been.calledOnceWithExactly({
        pubkey: PUBKEY,
        planId: null,
        status: null,
        active: false,
        currentPeriodEnd: null,
        accessEndsAt: null,
      })
    })
  })

  describe('the pubkey', () => {
    it('accepts an npub and looks it up by its hex', async () => {
      const res = makeRes()

      await makeController().handleRequest(makeReq({ pubkey: toBech32('npub')(PUBKEY) }), res)

      expect(res.status).to.have.been.calledWith(200)
      expect(repository.findByPubkey).to.have.been.calledOnceWithExactly(PUBKEY)
    })

    for (const [label, pubkey] of [
      ['missing', undefined],
      ['too short', 'abc'],
      ['not hex', 'z'.repeat(64)],
      ['upper case hex', 'A'.repeat(64)],
      ['an invalid npub', 'npub1invalid'],
      ['not a string', ['a'.repeat(64)]],
    ] as Array<[string, unknown]>) {
      it(`returns 400 when it is ${label}`, async () => {
        const res = makeRes()

        await makeController().handleRequest(makeReq({ pubkey }), res)

        expect(res.status).to.have.been.calledWith(400)
        expect(res.send).to.have.been.calledWith('Invalid pubkey')
        expect(repository.findByPubkey).not.to.have.been.called
      })
    }

    it('returns 400 when there is no query at all', async () => {
      const res = makeRes()

      await makeController().handleRequest({ ...makeReq(), query: undefined }, res)

      expect(res.status).to.have.been.calledWith(400)
    })
  })

  describe('when subscriptions are not in use', () => {
    it('returns 404 while no plan is configured', async () => {
      currentSettings = baseSettings({ payments: { enabled: true, subscriptionPlans: [] } })
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(404)
      expect(repository.findByPubkey).not.to.have.been.called
    })

    it('returns 404 while payments are off', async () => {
      currentSettings = baseSettings()
      currentSettings.payments.enabled = false
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(404)
    })
  })

  describe('rate limiting', () => {
    const limited = () =>
      baseSettings({ limits: { invoice: { rateLimits: [{ rate: 2, period: 60000 }], ipWhitelist: [] } } })

    it('returns 429 when the invoice limits are exceeded, without reading anything', async () => {
      currentSettings = limited()
      rateLimiterHit.resolves(true)
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(429)
      expect(repository.findByPubkey).not.to.have.been.called
    })

    it('counts the caller under its own key and the limits of the invoice endpoints', async () => {
      currentSettings = limited()

      await makeController().handleRequest(makeReq(), makeRes())

      expect(rateLimiterHit).to.have.been.calledOnceWithExactly('1.2.3.4:subscription-status:60000', 1, {
        period: 60000,
        rate: 2,
      })
    })

    it('does not limit a whitelisted address', async () => {
      currentSettings = baseSettings({
        limits: { invoice: { rateLimits: [{ rate: 2, period: 60000 }], ipWhitelist: ['1.2.3.4'] } },
      })
      rateLimiterHit.resolves(true)
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(res.status).to.have.been.calledWith(200)
    })

    it('does not limit when no limits are configured', async () => {
      const res = makeRes()

      await makeController().handleRequest(makeReq(), res)

      expect(rateLimiterHit).not.to.have.been.called
      expect(res.status).to.have.been.calledWith(200)
    })
  })
})
