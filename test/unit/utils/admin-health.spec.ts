import { expect } from 'chai'

import { getAdminDependencyPingTimeoutMs } from '../../../src/utils/admin-health'

describe('admin-health', () => {
  const originalTimeout = process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS
    } else {
      process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS = originalTimeout
    }
  })

  it('defaults dependency ping timeout when unset', () => {
    delete process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS

    expect(getAdminDependencyPingTimeoutMs()).to.equal(3000)
  })

  it('uses a valid configured dependency ping timeout', () => {
    process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS = '2500'

    expect(getAdminDependencyPingTimeoutMs()).to.equal(2500)
  })

  it('falls back when configured dependency ping timeout is below the minimum', () => {
    process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS = '50'

    expect(getAdminDependencyPingTimeoutMs()).to.equal(3000)
  })

  it('falls back when configured dependency ping timeout is not numeric', () => {
    process.env.ADMIN_DEPENDENCY_PING_TIMEOUT_MS = 'abc'

    expect(getAdminDependencyPingTimeoutMs()).to.equal(3000)
  })
})
