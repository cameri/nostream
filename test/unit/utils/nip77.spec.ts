import { expect } from 'chai'

import {
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_MAX_SESSIONS_PER_CONNECTION,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  getNip77Limits,
  isNip77Active,
  NEGENTROPY_FRAME_SIZE_LIMIT,
} from '../../../src/utils/nip77'
import { Settings } from '../../../src/@types/settings'

describe('NIP-77 helpers', () => {
  describe('isNip77Active', () => {
    it('is off by default', () => {
      expect(isNip77Active({} as Settings)).to.equal(false)
    })

    it('is off when nip77.enabled is false', () => {
      expect(isNip77Active({ nip77: { enabled: false } } as Settings)).to.equal(false)
    })

    it('is on when enabled and the event store is postgres', () => {
      expect(isNip77Active({ nip77: { enabled: true }, eventStore: { backend: 'postgres' } } as Settings)).to.equal(
        true,
      )
    })

    it('treats an unset event store as postgres', () => {
      expect(isNip77Active({ nip77: { enabled: true } } as Settings)).to.equal(true)
    })

    it('only accepts a literal true', () => {
      expect(isNip77Active({ nip77: { enabled: 'yes' } } as any)).to.equal(false)
    })
  })

  describe('getNip77Limits', () => {
    it('falls back to the defaults', () => {
      expect(getNip77Limits({} as Settings)).to.deep.equal({
        maxEventsPerSession: DEFAULT_MAX_EVENTS_PER_SESSION,
        maxSessionsPerConnection: DEFAULT_MAX_SESSIONS_PER_CONNECTION,
        sessionIdleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
      })
    })

    it('uses configured values', () => {
      expect(
        getNip77Limits({
          nip77: { maxEventsPerSession: 10, maxSessionsPerConnection: 2, sessionIdleTimeoutMs: 500 },
        } as Settings),
      ).to.deep.equal({ maxEventsPerSession: 10, maxSessionsPerConnection: 2, sessionIdleTimeoutMs: 500 })
    })
  })

  it('keeps the frame size limit above the 4096 bytes negentropy requires', () => {
    expect(NEGENTROPY_FRAME_SIZE_LIMIT).to.be.at.least(4096)
  })
})
