import { After, Before, Then, When, World } from '@cucumber/cucumber'
import { expect } from 'chai'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Sinon from 'sinon'

import { PatchAdminNotificationsController } from '../../../../src/controllers/admin/patch-notifications-controller'
import { PatchAdminSettingsController } from '../../../../src/controllers/admin/patch-settings-controller'
import { PostAdminSettingsRestoreController } from '../../../../src/controllers/admin/post-settings-restore-controller'
import {
  ensureSettingsExists,
  getSettingsBackupDir,
  getSettingsFilePath,
  getSettingsWriteLockPath,
  loadUserSettings,
  saveSettings,
  withSettingsWriteLock,
} from '../../../../src/utils/settings-config'
import * as audit from '../../../../src/utils/record-admin-audit'

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makeResponse = () => {
  const response: any = {
    status: Sinon.stub(),
    setHeader: Sinon.stub(),
    send: Sinon.stub(),
  }
  response.status.returns(response)
  response.setHeader.returns(response)
  response.send.returns(response)

  return response
}

Before({ tags: '@settings-write-lock' }, function (this: World<Record<string, any>>) {
  this.parameters.settingsConfigDir = process.env.NOSTR_CONFIG_DIR
  this.parameters.settingsTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-settings-integration-'))
  process.env.NOSTR_CONFIG_DIR = this.parameters.settingsTmpDir
  this.parameters.settingsSandbox = Sinon.createSandbox()
  this.parameters.settingsSandbox.stub(audit, 'recordAdminAuditFromRequest').resolves()
  this.parameters.settingsOutbox = { enqueue: Sinon.stub().resolves() }
  this.parameters.settingsResponses = {}

  ensureSettingsExists()
})

After({ tags: '@settings-write-lock' }, function (this: World<Record<string, any>>) {
  this.parameters.settingsSandbox?.restore()
  fs.rmSync(this.parameters.settingsTmpDir, { recursive: true, force: true })
  if (this.parameters.settingsConfigDir === undefined) {
    delete process.env.NOSTR_CONFIG_DIR
  } else {
    process.env.NOSTR_CONFIG_DIR = this.parameters.settingsConfigDir
  }

  this.parameters.settingsConfigDir = undefined
  this.parameters.settingsTmpDir = undefined
  this.parameters.settingsSandbox = undefined
  this.parameters.settingsOutbox = undefined
  this.parameters.settingsResponses = {}
  this.parameters.settingsLockOrder = undefined
  this.parameters.settingsLockMetadata = undefined
})

When('two settings writers queue for the lock', async function (this: World<Record<string, any>>) {
  const lockPath = getSettingsWriteLockPath()
  const order: string[] = []
  let acquired!: () => void
  let release!: () => void
  const firstAcquired = new Promise<void>((resolve) => {
    acquired = resolve
  })
  const holdFirst = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = withSettingsWriteLock(async () => {
    order.push('first')
    this.parameters.settingsLockMetadata = fs.readFileSync(lockPath, 'utf-8').trim().split('\n')
    acquired()
    await holdFirst
  })

  await firstAcquired
  const second = withSettingsWriteLock(() => {
    order.push('second')
  })

  await delay(50)
  expect(order).to.deep.equal(['first'])

  release()
  await Promise.all([first, second])
  this.parameters.settingsLockOrder = order
})

Then('the writers run one after the other', function (this: World<Record<string, any>>) {
  expect(this.parameters.settingsLockOrder).to.deep.equal(['first', 'second'])
})

Then('the lock records the owner host and token', function (this: World<Record<string, any>>) {
  const [pid, acquiredAt, hostname, token] = this.parameters.settingsLockMetadata as string[]

  expect(Number(pid)).to.equal(process.pid)
  expect(Number(acquiredAt)).to.be.greaterThan(0)
  expect(hostname).to.equal(os.hostname())
  expect(token).to.match(/^[0-9a-f-]{36}$/)
  expect(fs.existsSync(getSettingsWriteLockPath())).to.equal(false)
})

When(
  'the admin notifications controller saves settings',
  async function (this: World<Record<string, any>>) {
    const controller = new PatchAdminNotificationsController(this.parameters.settingsOutbox)
    const response = makeResponse()
    this.parameters.settingsResponses.notifications = response

    await controller.handleRequest({ body: { enabled: true }, ip: '127.0.0.1' } as any, response)
  },
)

Then(
  'the notifications are saved and the lock is released',
  function (this: World<Record<string, any>>) {
    const response = this.parameters.settingsResponses.notifications
    const saved = loadUserSettings() as any

    Sinon.assert.calledWith(response.status, 200)
    expect(saved.admin.notifications.enabled).to.equal(true)
    expect(fs.existsSync(getSettingsWriteLockPath())).to.equal(false)
  },
)

When(
  'the admin settings controller saves a client subscription limit',
  async function (this: World<Record<string, any>>) {
    const controller = new PatchAdminSettingsController(this.parameters.settingsOutbox)
    const response = makeResponse()
    this.parameters.settingsResponses.settings = response

    await controller.handleRequest(
      {
        body: { path: 'limits.client.subscription.maxSubscriptions', value: 12 },
        ip: '127.0.0.1',
      } as any,
      response,
    )
  },
)

Then(
  'the saved settings contain that limit and the lock is released',
  function (this: World<Record<string, any>>) {
    const response = this.parameters.settingsResponses.settings
    const saved = loadUserSettings() as any

    Sinon.assert.calledWith(response.status, 200)
    expect(saved.limits.client.subscription.maxSubscriptions).to.equal(12)
    expect(fs.existsSync(getSettingsWriteLockPath())).to.equal(false)
  },
)

When('an admin settings backup is restored', async function (this: World<Record<string, any>>) {
  const backupDir = getSettingsBackupDir()
  fs.mkdirSync(backupDir, { recursive: true })
  const filename = 'settings.2026-11-02T12-00-00-000Z.yaml'
  const current = loadUserSettings()
  saveSettings({ ...current, info: { ...current.info, name: 'restored-from-integration' } } as any)
  fs.copyFileSync(getSettingsFilePath(), path.join(backupDir, filename))

  const controller = new PostAdminSettingsRestoreController()
  const response = makeResponse()
  this.parameters.settingsResponses.restore = response

  await controller.handleRequest({ body: { filename }, ip: '127.0.0.1' } as any, response)
})

Then(
  'the restored settings are saved and the lock is released',
  function (this: World<Record<string, any>>) {
    const response = this.parameters.settingsResponses.restore
    const saved = loadUserSettings() as any

    Sinon.assert.calledWith(response.status, 200)
    expect(saved.info.name).to.equal('restored-from-integration')
    expect(fs.existsSync(getSettingsWriteLockPath())).to.equal(false)
  },
)
