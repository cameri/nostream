import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import { NegentropySession } from '../../../src/@types/negentropy'
import { Negentropy, NegentropyStorageVector } from '../../../src/utils/negentropy'
import { NegentropySessions } from '../../../src/utils/negentropy-sessions'

chai.use(sinonChai)
const { expect } = chai

const newSession = (filter: NegentropySession['filter'] = {}): NegentropySession => {
  const storage = new NegentropyStorageVector()
  storage.seal()

  return { negentropy: new Negentropy(storage), filter }
}

describe('NegentropySessions', () => {
  let clock: Sinon.SinonFakeTimers
  let onIdleTimeout: Sinon.SinonStub
  let sessions: NegentropySessions

  beforeEach(() => {
    clock = Sinon.useFakeTimers()
    onIdleTimeout = Sinon.stub()
    sessions = new NegentropySessions(onIdleTimeout)
  })

  afterEach(() => {
    sessions.closeAll()
    clock.restore()
  })

  describe('reserve and activate', () => {
    it('stores a session once it is activated', () => {
      const session = newSession()

      const token = sessions.reserve('a', 3)
      expect(token).to.not.be.undefined
      expect(sessions.activate('a', token as symbol, session, 1000)).to.equal(true)

      expect(sessions.touch('a')).to.equal(session)
      expect(sessions.getSessionIds()).to.deep.equal(['a'])
    })

    it('does not list a reservation that is not active yet', () => {
      sessions.reserve('a', 3)

      expect(sessions.getSessionIds()).to.deep.equal([])
      expect(sessions.touch('a')).to.be.undefined
    })

    it('refuses a new id once the limit is reached, counting reservations', () => {
      sessions.reserve('a', 2)
      sessions.reserve('b', 2)

      expect(sessions.reserve('c', 2)).to.be.undefined
    })

    it('lets an id that is already open be reopened at the limit, replacing the old session', () => {
      const first = newSession()
      const second = newSession()
      const token1 = sessions.reserve('a', 1) as symbol
      sessions.activate('a', token1, first, 1000)

      const token2 = sessions.reserve('a', 1)
      expect(token2).to.not.be.undefined
      sessions.activate('a', token2 as symbol, second, 1000)

      expect(sessions.touch('a')).to.equal(second)
    })

    it('refuses to activate a reservation that was replaced meanwhile', () => {
      const stale = sessions.reserve('a', 3) as symbol
      sessions.reserve('a', 3)

      expect(sessions.activate('a', stale, newSession(), 1000)).to.equal(false)
      expect(sessions.touch('a')).to.be.undefined
    })

    it('refuses to activate a reservation that was closed meanwhile', () => {
      const token = sessions.reserve('a', 3) as symbol
      sessions.close('a')

      expect(sessions.activate('a', token, newSession(), 1000)).to.equal(false)
    })

    it('frees the slot when a reservation is released and its read has ended', () => {
      const token = sessions.reserve('a', 1) as symbol

      sessions.release('a', token)
      sessions.endRead(token)

      expect(sessions.reserve('b', 1)).to.not.be.undefined
    })

    it('does not release a newer reservation with an old token', () => {
      const stale = sessions.reserve('a', 3) as symbol
      const current = sessions.reserve('a', 3) as symbol

      sessions.release('a', stale)

      expect(sessions.activate('a', current, newSession(), 1000)).to.equal(true)
    })
  })

  describe('reads in flight', () => {
    it('keeps counting the read of a replaced request until it ends', () => {
      sessions.reserve('a', 2)
      sessions.reserve('a', 2) // replaces the first, whose read is still running

      expect(sessions.reserve('a', 2)).to.be.undefined
    })

    it('stops counting a read once it ends', () => {
      const first = sessions.reserve('a', 2) as symbol
      sessions.reserve('a', 2)

      sessions.endRead(first)

      expect(sessions.reserve('a', 2)).to.not.be.undefined
    })

    it('does not count a read twice or after it was never started', () => {
      const token = sessions.reserve('a', 2) as symbol

      sessions.endRead(token)
      sessions.endRead(token)

      expect(sessions.reserve('b', 2)).to.not.be.undefined
      expect(sessions.reserve('c', 2)).to.be.undefined // the two sessions a and b fill the limit
    })

    it('counts a read as over once its session is activated', () => {
      const token = sessions.reserve('a', 1) as symbol
      sessions.activate('a', token, newSession(), 1000)

      expect(sessions.reserve('a', 1)).to.not.be.undefined
    })

    it('reports whether a token still owns its id', () => {
      const first = sessions.reserve('a', 3) as symbol
      expect(sessions.isCurrent('a', first)).to.equal(true)

      const second = sessions.reserve('a', 3) as symbol

      expect(sessions.isCurrent('a', first)).to.equal(false)
      expect(sessions.isCurrent('a', second)).to.equal(true)
      sessions.close('a')
      expect(sessions.isCurrent('a', second)).to.equal(false)
    })

    it('keeps the filter a session was opened with', () => {
      const filter = { kinds: [1], authors: ['a'.repeat(64)] }
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(filter), 1000)

      expect(sessions.touch('a')?.filter).to.deep.equal(filter)
    })
  })

  describe('close', () => {
    it('removes a session and reports whether there was one', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)

      expect(sessions.close('a')).to.equal(true)
      expect(sessions.close('a')).to.equal(false)
      expect(sessions.touch('a')).to.be.undefined
    })

    it('closeAll removes every session and reservation', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)
      const pending = sessions.reserve('b', 3) as symbol

      sessions.closeAll()
      sessions.endRead(pending)

      expect(sessions.getSessionIds()).to.deep.equal([])
      expect(sessions.reserve('c', 1)).to.not.be.undefined
    })
  })

  describe('idle timeout', () => {
    it('closes an idle session and tells the caller', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)

      clock.tick(1000)

      expect(onIdleTimeout).to.have.been.calledOnceWithExactly('a')
      expect(sessions.touch('a')).to.be.undefined
    })

    it('restarts the timer whenever the session is touched', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)

      clock.tick(900)
      sessions.touch('a')
      clock.tick(900)

      expect(onIdleTimeout).to.not.have.been.called
      clock.tick(100)
      expect(onIdleTimeout).to.have.been.calledOnceWithExactly('a')
    })

    it('does not fire for a session closed before the timeout', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)

      sessions.close('a')
      clock.tick(5000)

      expect(onIdleTimeout).to.not.have.been.called
    })

    it('does not fire for a replaced session', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 1000)
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 10000)

      clock.tick(1000)

      expect(onIdleTimeout).to.not.have.been.called
    })

    it('never times out when the timeout is not positive', () => {
      sessions.activate('a', sessions.reserve('a', 3) as symbol, newSession(), 0)

      clock.tick(10 * 60 * 1000)

      expect(onIdleTimeout).to.not.have.been.called
      expect(sessions.getSessionIds()).to.deep.equal(['a'])
    })
  })
})
