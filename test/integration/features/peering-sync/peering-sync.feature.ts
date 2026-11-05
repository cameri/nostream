import { Then, When, World } from '@cucumber/cucumber'
import chai from 'chai'
import { SubscriptionFilter } from '../../../../src/@types/subscription'
import {
  peeringScopesToLiveFilters,
  peeringScopeToFilters,
  splitPeeringFilter,
} from '../../../../src/utils/peering-scope'
import { isBlockedNip11Address } from '../../../../src/utils/relay-probe/nip11-probe'

const { expect } = chai

When(
  'a peering scope covers kinds {int} through {int}',
  function (this: World<Record<string, any>>, from: number, to: number) {
    this.parameters.peeringFilters = peeringScopeToFilters({ kinds: [[from, to] as any] }, 1_000, 4)
  },
)

Then('the scope produces filters of at most {int} kinds', function (this: World<Record<string, any>>, limit: number) {
  const filters = this.parameters.peeringFilters as SubscriptionFilter[]
  expect(filters.length).to.be.greaterThan(0)
  expect(filters.every((filter) => (filter.kinds?.length ?? 0) <= limit)).to.equal(true)
})

When(
  'a peering scope uses a {int} second rolling window at {int}',
  function (this: World<Record<string, any>>, windowSeconds: number, now: number) {
    this.parameters.peeringLiveFilters = peeringScopesToLiveFilters([{ kinds: [1], windowSeconds }], now, 60)
  },
)

Then('its live filter starts at {int}', function (this: World<Record<string, any>>, since: number) {
  const [filter] = this.parameters.peeringLiveFilters as SubscriptionFilter[]
  expect(filter.since).to.equal(since)
})

When('an unbounded peering filter is split at {int}', function (this: World<Record<string, any>>, now: number) {
  this.parameters.peeringSplit = splitPeeringFilter({ kinds: [1] }, now)
})

Then(
  'the split filters cover {int} to {int} and {int} to {int}',
  function (
    this: World<Record<string, any>>,
    firstSince: number,
    firstUntil: number,
    secondSince: number,
    secondUntil: number,
  ) {
    const [first, second] = this.parameters.peeringSplit as [SubscriptionFilter, SubscriptionFilter]
    expect([first.since, first.until]).to.deep.equal([firstSince, firstUntil])
    expect([second.since, second.until]).to.deep.equal([secondSince, secondUntil])
  },
)

Then('the NIP-11 address {string} is blocked', function (this: World<Record<string, any>>, address: string) {
  expect(isBlockedNip11Address(address)).to.equal(true)
})
