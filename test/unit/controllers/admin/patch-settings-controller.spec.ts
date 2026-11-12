import chai from 'chai'
import Sinon from 'sinon'
import sinonChai from 'sinon-chai'

import * as recordAdminAudit from '../../../../src/utils/record-admin-audit'
import * as settingsConfig from '../../../../src/utils/settings-config'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PatchAdminSettingsController } = require('../../../../src/controllers/admin/patch-settings-controller')

chai.use(sinonChai)

const { expect } = chai

const baseSettings = {
  payments: { enabled: false },
  info: { relay_url: 'wss://relay.example', name: 'test' },
}

describe('PatchAdminSettingsController settings write lock', () => {
  let sandbox: Sinon.SinonSandbox
  let outboxRepository: { enqueue: Sinon.SinonStub }
  let response: { status: Sinon.SinonStub; setHeader: Sinon.SinonStub; send: Sinon.SinonStub }
  let request: Record<string, unknown>

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    outboxRepository = { enqueue: sandbox.stub().resolves() }
    response = {
      status: sandbox.stub().returnsThis(),
      setHeader: sandbox.stub().returnsThis(),
      send: sandbox.stub().returnsThis(),
    }
    request = { body: { path: 'payments.enabled', value: true }, ip: '127.0.0.1' }

    sandbox.stub(settingsConfig, 'withSettingsWriteLock').callsFake(async (operation: () => unknown) => operation())
    sandbox.stub(settingsConfig, 'loadUserSettings').returns(baseSettings as any)
    sandbox.stub(settingsConfig, 'loadMergedSettings').returns(baseSettings as any)
    sandbox.stub(settingsConfig, 'saveSettings')
    sandbox.stub(settingsConfig, 'appendSettingsAuditLog')
    sandbox.stub(settingsConfig, 'validatePathAgainstDefaults').returns([])
    sandbox.stub(settingsConfig, 'validateSettings').returns([])
    sandbox.stub(recordAdminAudit, 'recordAdminAuditFromRequest').resolves()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('re-reads and saves inside the settings write lock', async () => {
    const order: string[] = []
    ;(settingsConfig.withSettingsWriteLock as Sinon.SinonStub).callsFake(async (operation: () => unknown) => {
      order.push('lock:enter')
      try {
        return operation()
      } finally {
        order.push('lock:exit')
      }
    })
    ;(settingsConfig.loadUserSettings as Sinon.SinonStub).callsFake(() => {
      order.push('read')
      return baseSettings
    })
    ;(settingsConfig.loadMergedSettings as Sinon.SinonStub).callsFake(() => {
      order.push('merged')
      return baseSettings
    })
    ;(settingsConfig.saveSettings as Sinon.SinonStub).callsFake(() => {
      order.push('save')
    })

    const controller = new PatchAdminSettingsController(outboxRepository as any)
    await controller.handleRequest(request as any, response as any)

    // The read has to happen after the lock is acquired. Otherwise a ban written
    // by another worker between the read and the save would be overwritten.
    expect(order).to.deep.equal(['lock:enter', 'read', 'merged', 'save', 'lock:exit'])
    expect(response.status).to.have.been.calledOnceWithExactly(200)
  })

  it('keeps a moderation ban written before the lock is acquired', async () => {
    let stored = {
      payments: { enabled: false },
      limits: { event: { pubkey: { blacklist: [] as string[] } } },
      info: { relay_url: 'wss://relay.example', name: 'test' },
    }
    ;(settingsConfig.withSettingsWriteLock as Sinon.SinonStub).callsFake(async (operation: () => unknown) => {
      // Another worker bans a pubkey just before this writer gets the lock.
      stored = {
        ...stored,
        limits: { event: { pubkey: { blacklist: ['banned-pubkey'] } } },
      }
      return operation()
    })
    ;(settingsConfig.loadUserSettings as Sinon.SinonStub).callsFake(() => stored)
    ;(settingsConfig.loadMergedSettings as Sinon.SinonStub).callsFake(() => stored)
    ;(settingsConfig.saveSettings as Sinon.SinonStub).callsFake((next: typeof stored) => {
      stored = next
    })

    const controller = new PatchAdminSettingsController(outboxRepository as any)
    await controller.handleRequest(request as any, response as any)

    // The ordinary save must not revert the ban; it also applies its own change.
    expect(stored.limits.event.pubkey.blacklist).to.deep.equal(['banned-pubkey'])
    expect(stored.payments.enabled).to.equal(true)
  })

  it('never reads settings outside the lock', async () => {
    let locked = false
    const readsWhileLocked: boolean[] = []
    ;(settingsConfig.withSettingsWriteLock as Sinon.SinonStub).callsFake(async (operation: () => unknown) => {
      locked = true
      try {
        return operation()
      } finally {
        locked = false
      }
    })
    ;(settingsConfig.loadUserSettings as Sinon.SinonStub).callsFake(() => {
      readsWhileLocked.push(locked)
      return baseSettings
    })
    ;(settingsConfig.loadMergedSettings as Sinon.SinonStub).callsFake(() => {
      readsWhileLocked.push(locked)
      return baseSettings
    })

    const controller = new PatchAdminSettingsController(outboxRepository as any)
    await controller.handleRequest(request as any, response as any)

    expect(readsWhileLocked).to.deep.equal([true, true])
  })

  it('does not save when merged validation fails', async () => {
    ;(settingsConfig.validateSettings as Sinon.SinonStub).returns([{ path: 'payments', message: 'bad' }])

    const controller = new PatchAdminSettingsController(outboxRepository as any)
    await controller.handleRequest(request as any, response as any)

    expect(response.status).to.have.been.calledOnceWithExactly(400)
    expect(response.send.firstCall.args[0]).to.deep.equal({
      error: 'Validation failed',
      issues: [{ path: 'payments', message: 'bad' }],
    })
    expect(settingsConfig.saveSettings).not.to.have.been.called
    expect(settingsConfig.appendSettingsAuditLog).not.to.have.been.called
    expect(outboxRepository.enqueue).not.to.have.been.called
  })
})
