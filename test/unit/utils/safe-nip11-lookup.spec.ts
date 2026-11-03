import { expect } from 'chai'

import { isBlockedNip11Address, safeNip11Lookup } from '../../../src/utils/relay-probe/nip11-probe'

describe('safe NIP-11 lookup', () => {
  it('blocks loopback, private, link-local, multicast, and mapped addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedNip11Address(address), address).to.equal(true)
    }
  })

  it('allows public addresses', () => {
    expect(isBlockedNip11Address('8.8.8.8')).to.equal(false)
    expect(isBlockedNip11Address('2606:4700:4700::1111')).to.equal(false)
  })

  it('rejects a literal private address before connecting', async () => {
    const error = await safeNip11Lookup('127.0.0.1', {}).then(
      () => undefined,
      (err: Error) => err,
    )

    expect(error?.message).to.include('resolving to a private address')
  })
})
