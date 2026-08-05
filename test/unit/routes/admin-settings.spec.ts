import axios from 'axios'
import { expect } from 'chai'
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Sinon from 'sinon'

import { hashAdminPassword } from '../../../src/utils/admin-password'
import * as adminRateLimitMiddleware from '../../../src/handlers/request-handlers/admin-rate-limit-middleware'
import * as rateLimiterMiddleware from '../../../src/handlers/request-handlers/rate-limiter-middleware'
import * as settingsFactory from '../../../src/factories/settings-factory'
import {
  getSettingsAuditLogPath,
  getSettingsBackupDir,
  getSettingsFilePath,
  loadDefaults,
  saveSettings,
} from '../../../src/utils/settings-config'

describe('admin settings API', () => {
  const originalSecret = process.env.SECRET
  const originalAdminPassword = process.env.ADMIN_PASSWORD
  const originalConfigDir = process.env.NOSTR_CONFIG_DIR
  let configDir: string
  let createSettingsStub: Sinon.SinonStub
  let rateLimiterMiddlewareStub: Sinon.SinonStub
  let adminRateLimitMiddlewareStub: Sinon.SinonStub
  let adminLoginRateLimitMiddlewareStub: Sinon.SinonStub
  let server: any

  const loadAdminRouter = () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../../src/routes/admin/index')]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    delete require.cache[require.resolve('../../../src/routes/admin')]
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../src/routes/admin').default
  }

  const startServer = async (settings: Record<string, unknown>) => {
    createSettingsStub = Sinon.stub(settingsFactory, 'createSettings').returns(settings as any)
    const passthrough = async (_request: any, _response: any, next: any) => {
      next()
    }
    rateLimiterMiddlewareStub = Sinon.stub(rateLimiterMiddleware, 'rateLimiterMiddleware').callsFake(passthrough)
    adminRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminRateLimitMiddleware').callsFake(
      passthrough,
    )
    adminLoginRateLimitMiddlewareStub = Sinon.stub(adminRateLimitMiddleware, 'adminLoginRateLimitMiddleware').callsFake(
      passthrough,
    )
    const router = loadAdminRouter()
    const app = express()
    app.use('/admin', router)

    server = await new Promise((resolve) => {
      const listeningServer = app.listen(0, () => resolve(listeningServer))
    })

    return `http://127.0.0.1:${server.address().port}/admin`
  }

  const stopServer = async () => {
    createSettingsStub?.restore()
    rateLimiterMiddlewareStub?.restore()
    adminRateLimitMiddlewareStub?.restore()
    adminLoginRateLimitMiddlewareStub?.restore()
    delete require.cache[require.resolve('../../../src/routes/admin/index')]
    delete require.cache[require.resolve('../../../src/routes/admin')]

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
      server = undefined
    }
  }

  const login = async (baseUrl: string): Promise<string> => {
    const loginResponse = await axios.post(
      `${baseUrl}/login`,
      { password: 'settings-password' },
      {
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(loginResponse.status).to.equal(200)
    return loginResponse.headers['set-cookie']?.[0]?.split(';')[0] ?? ''
  }

  before(() => {
    process.env.SECRET = 'test-admin-secret-value'
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-admin-settings-'))
    process.env.NOSTR_CONFIG_DIR = configDir
  })

  after(() => {
    if (originalSecret === undefined) {
      delete process.env.SECRET
    } else {
      process.env.SECRET = originalSecret
    }

    if (originalAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD
    } else {
      process.env.ADMIN_PASSWORD = originalAdminPassword
    }

    if (originalConfigDir === undefined) {
      delete process.env.NOSTR_CONFIG_DIR
    } else {
      process.env.NOSTR_CONFIG_DIR = originalConfigDir
    }

    fs.rmSync(configDir, { recursive: true, force: true })
  })

  afterEach(async () => {
    delete process.env.ADMIN_PASSWORD
    fs.rmSync(getSettingsFilePath(), { force: true })
    await stopServer()
  })

  it('requires authentication for settings routes', async () => {
    const baseUrl = await startServer({ admin: { enabled: true } })

    const settingsResponse = await axios.get(`${baseUrl}/settings`, { validateStatus: () => true })
    const schemaResponse = await axios.get(`${baseUrl}/settings/schema`, { validateStatus: () => true })
    const validateResponse = await axios.post(`${baseUrl}/settings/validate`, {}, { validateStatus: () => true })
    const patchResponse = await axios.patch(
      `${baseUrl}/settings`,
      { path: 'payments.enabled', value: true },
      {
        headers: { 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(settingsResponse.status).to.equal(401)
    expect(schemaResponse.status).to.equal(401)
    expect(validateResponse.status).to.equal(401)
    expect(patchResponse.status).to.equal(401)
  })

  it('returns redacted merged settings and guided schema', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    saveSettings({
      ...loadDefaults(),
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
      mirroring: {
        static: [{ address: 'wss://mirror.example', secret: 'mirror-secret-value' }],
      },
    })
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    const settingsResponse = await axios.get(`${baseUrl}/settings`, {
      headers: { cookie },
      validateStatus: () => true,
    })
    const schemaResponse = await axios.get(`${baseUrl}/settings/schema`, {
      headers: { cookie },
      validateStatus: () => true,
    })

    expect(settingsResponse.status).to.equal(200)
    expect(settingsResponse.data.settings.admin.passwordHash).to.equal('***')
    expect(settingsResponse.data.settings.mirroring.static[0].secret).to.equal('***')
    expect(settingsResponse.data.settings.info.name).to.be.a('string')

    expect(schemaResponse.status).to.equal(200)
    expect(schemaResponse.data.categories.some((entry: { value: string }) => entry.value === 'payments')).to.equal(true)
  })

  it('patches a setting path with validation and persists to settings.yaml', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    const patchResponse = await axios.patch(
      `${baseUrl}/settings`,
      { path: 'payments.enabled', value: true },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(patchResponse.status).to.equal(200)
    expect(patchResponse.data).to.deep.equal({
      ok: true,
      path: 'payments.enabled',
      value: true,
      reload: 'restart-required',
    })

    const settingsRaw = fs.readFileSync(getSettingsFilePath(), 'utf-8')
    expect(settingsRaw).to.include('payments:')
    expect(settingsRaw).to.include('enabled: true')
  })

  it('atomically applies staged changes with a backup and audit entry', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    saveSettings({
      ...loadDefaults(),
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    const patchResponse = await axios.patch(
      `${baseUrl}/settings`,
      {
        changes: [
          { path: 'payments.enabled', value: true },
          { path: 'nip50.enabled', value: true },
        ],
      },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(patchResponse.status, JSON.stringify(patchResponse.data)).to.equal(200)
    expect(patchResponse.data.changes).to.have.length(2)
    expect(fs.readdirSync(getSettingsBackupDir()).some((name) => name.startsWith('settings.'))).to.equal(true)
    expect(fs.readFileSync(getSettingsAuditLogPath(), 'utf-8')).to.include('settings.updated')
  })

  it('lists and restores the latest settings backup', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    saveSettings({
      ...loadDefaults(),
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
      payments: { ...loadDefaults().payments, enabled: false },
    })
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    await axios.patch(
      `${baseUrl}/settings`,
      { path: 'payments.enabled', value: true },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    const backupsResponse = await axios.get(`${baseUrl}/settings/backups`, {
      headers: { cookie },
      validateStatus: () => true,
    })

    expect(backupsResponse.status).to.equal(200)
    expect(backupsResponse.data.backups.length).to.be.greaterThan(0)

    const restoreResponse = await axios.post(
      `${baseUrl}/settings/restore`,
      { filename: backupsResponse.data.backups[0].filename },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(restoreResponse.status).to.equal(200)
    expect(fs.readFileSync(getSettingsAuditLogPath(), 'utf-8')).to.include('settings.restored')
  })

  it('rejects invalid paths and write-protected settings', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    const unknownPathResponse = await axios.patch(
      `${baseUrl}/settings`,
      { path: 'payments.fakeField', value: true },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )
    const protectedPathResponse = await axios.patch(
      `${baseUrl}/settings`,
      { path: 'admin.passwordHash', value: 'new-hash' },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )
    const invalidBodyResponse = await axios.patch(
      `${baseUrl}/settings`,
      { path: 'payments.enabled', unexpected: true },
      {
        headers: { cookie, 'content-type': 'application/json' },
        validateStatus: () => true,
      },
    )

    expect(unknownPathResponse.status).to.equal(400)
    expect(unknownPathResponse.data.error).to.equal('Validation failed')
    expect(protectedPathResponse.status).to.equal(400)
    expect(protectedPathResponse.data.issues[0].message).to.equal('Path is write-protected')
    expect(invalidBodyResponse.status).to.equal(400)
    expect(invalidBodyResponse.data.error).to.equal('Invalid request')
  })

  it('validates merged settings', async () => {
    const passwordHash = hashAdminPassword('settings-password')
    const baseUrl = await startServer({
      admin: { enabled: true, passwordHash, sessionTtlSeconds: 3600 },
    })
    const cookie = await login(baseUrl)

    const validateResponse = await axios.post(
      `${baseUrl}/settings/validate`,
      {},
      {
        headers: { cookie },
        validateStatus: () => true,
      },
    )

    expect(validateResponse.status).to.equal(200)
    expect(validateResponse.data.valid).to.equal(true)
    expect(validateResponse.data.issues).to.deep.equal([])
  })
})
