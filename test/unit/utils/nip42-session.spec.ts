import { expect } from 'chai'

import { Nip42SessionManager } from '../../../src/utils/nip42-session'

describe('Nip42SessionManager', () => {
  it('issues a non-empty challenge on construction', () => {
    const session = new Nip42SessionManager()
    expect(session.getChallenge()).to.be.a('string').with.length.greaterThan(0)
  })

  it('rotateChallenge replaces the active challenge', () => {
    const session = new Nip42SessionManager()
    const previous = session.getChallenge()
    const next = session.rotateChallenge()

    expect(next).to.be.a('string').with.length.greaterThan(0)
    expect(next).not.to.equal(previous)
    expect(session.getChallenge()).to.equal(next)
  })

  it('authenticate adds a pubkey to the session', () => {
    const session = new Nip42SessionManager()
    const pubkey = 'a'.repeat(64)

    expect(session.authenticate(pubkey, '1'.repeat(64), 1_700_000_000)).to.equal(true)

    expect(session.isAuthenticated(pubkey, 1_700_000_000)).to.equal(true)
    expect(session.getAuthenticatedPubkeys(1_700_000_000).has(pubkey)).to.equal(true)
    expect(session.getSession(pubkey, 1_700_000_000)).to.deep.equal({
      pubkey,
      authenticatedAt: 1_700_000_000,
    })
  })

  it('rejects replayed AUTH event ids', () => {
    const session = new Nip42SessionManager()
    const pubkey = 'a'.repeat(64)
    const eventId = '1'.repeat(64)

    expect(session.authenticate(pubkey, eventId, 1000)).to.equal(true)
    expect(session.authenticate(pubkey, eventId, 1060)).to.equal(false)
    expect(session.getSession(pubkey, 1060)?.authenticatedAt).to.equal(1000)
  })

  it('supports multiple authenticated pubkeys', () => {
    const session = new Nip42SessionManager()
    const pk1 = 'a'.repeat(64)
    const pk2 = 'b'.repeat(64)

    expect(session.authenticate(pk1, '1'.repeat(64))).to.equal(true)
    expect(session.authenticate(pk2, '2'.repeat(64))).to.equal(true)

    const pubkeys = session.getAuthenticatedPubkeys()
    expect(pubkeys.size).to.equal(2)
    expect(pubkeys.has(pk1)).to.equal(true)
    expect(pubkeys.has(pk2)).to.equal(true)
  })

  it('clear removes one pubkey or the whole session', () => {
    const session = new Nip42SessionManager()
    const pk1 = 'a'.repeat(64)
    const pk2 = 'b'.repeat(64)
    session.authenticate(pk1, '1'.repeat(64))
    session.authenticate(pk2, '2'.repeat(64))

    session.clear(pk1)
    expect(session.isAuthenticated(pk1)).to.equal(false)
    expect(session.isAuthenticated(pk2)).to.equal(true)

    session.clear()
    expect(session.getAuthenticatedPubkeys().size).to.equal(0)
  })

  it('does not expire sessions when TTL is unset or non-positive', () => {
    const unsetTtl = new Nip42SessionManager(() => undefined)
    const zeroTtl = new Nip42SessionManager(() => 0)
    const pubkey = 'a'.repeat(64)

    unsetTtl.authenticate(pubkey, '1'.repeat(64), 100)
    zeroTtl.authenticate(pubkey, '2'.repeat(64), 100)

    expect(unsetTtl.isAuthenticated(pubkey, 1_000_000)).to.equal(true)
    expect(zeroTtl.isAuthenticated(pubkey, 1_000_000)).to.equal(true)
  })

  it('expires sessions after the configured TTL', () => {
    const session = new Nip42SessionManager(() => 60)
    const pubkey = 'a'.repeat(64)

    session.authenticate(pubkey, '1'.repeat(64), 1000)

    expect(session.isAuthenticated(pubkey, 1059)).to.equal(true)
    expect(session.isAuthenticated(pubkey, 1060)).to.equal(false)
    expect(session.getAuthenticatedPubkeys(1060).size).to.equal(0)
  })

  it('does not extend TTL when the same AUTH event is replayed', () => {
    const session = new Nip42SessionManager(() => 60)
    const pubkey = 'a'.repeat(64)
    const eventId = '1'.repeat(64)

    expect(session.authenticate(pubkey, eventId, 1000)).to.equal(true)
    expect(session.authenticate(pubkey, eventId, 1050)).to.equal(false)
    expect(session.isAuthenticated(pubkey, 1060)).to.equal(false)
  })
})
