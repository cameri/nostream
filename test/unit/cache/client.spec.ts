import { expect } from 'chai'

import { getCacheConfig } from '../../../src/cache/client'

describe('getCacheConfig', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.REDIS_URI
    delete process.env.REDIS_USER
    delete process.env.REDIS_PASSWORD
    delete process.env.REDIS_HOST
    delete process.env.REDIS_PORT
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('builds unauthenticated redis url when REDIS_URI and REDIS_PASSWORD are unset', () => {
    process.env.REDIS_HOST = 'localhost'
    process.env.REDIS_PORT = '6379'

    const config = getCacheConfig()

    expect(config).to.deep.equal({
      url: 'redis://localhost:6379',
    })
  })

  it('builds authenticated redis config when REDIS_PASSWORD is set', () => {
    process.env.REDIS_HOST = 'localhost'
    process.env.REDIS_PORT = '6379'
    process.env.REDIS_USER = 'default'
    process.env.REDIS_PASSWORD = 'secret'

    const config = getCacheConfig()

    expect(config).to.deep.equal({
      url: 'redis://localhost:6379',
      username: 'default',
      password: 'secret',
    })
  })

  it('defaults REDIS_USER to default when REDIS_PASSWORD is set and REDIS_USER is unset', () => {
    process.env.REDIS_HOST = 'localhost'
    process.env.REDIS_PORT = '6379'
    process.env.REDIS_PASSWORD = 'secret'

    const config = getCacheConfig()

    expect(config).to.deep.equal({
      url: 'redis://localhost:6379',
      username: 'default',
      password: 'secret',
    })
  })

  it('prefers REDIS_URI over host/port settings', () => {
    process.env.REDIS_URI = 'redis://cache.internal:6380'
    process.env.REDIS_PASSWORD = 'secret'

    const config = getCacheConfig()

    expect(config).to.deep.equal({
      url: 'redis://cache.internal:6380',
      password: 'secret',
    })
  })
})