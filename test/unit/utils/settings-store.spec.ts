import { expect } from 'chai'
import cluster, { Worker } from 'cluster'
import Sinon from 'sinon'

import * as settingsConfig from '../../../src/utils/settings-config'
import * as settingsStore from '../../../src/utils/settings-store'

describe('settings-store backend selection', () => {
  const originalBackend = process.env.SETTINGS_BACKEND

  afterEach(() => {
    if (originalBackend === undefined) {
      delete process.env.SETTINGS_BACKEND
    } else {
      process.env.SETTINGS_BACKEND = originalBackend
    }
  })

  it('defaults to file backend', () => {
    delete process.env.SETTINGS_BACKEND

    expect(settingsStore.getSettingsBackend()).to.equal('file')
  })

  it('selects db backend when SETTINGS_BACKEND=db', () => {
    process.env.SETTINGS_BACKEND = 'db'

    expect(settingsStore.getSettingsBackend()).to.equal('db')
  })
})

describe('settings-store cluster sync messages', () => {
  it('recognizes cluster sync messages from workers', () => {
    expect(
      settingsStore.isSettingsOverridesClusterSyncMessage({
        eventName: settingsStore.SETTINGS_OVERRIDES_CLUSTER_SYNC_EVENT,
      }),
    ).to.equal(true)
    expect(settingsStore.isSettingsOverridesClusterSyncMessage({ eventName: 'other' })).to.equal(false)
  })
})

describe('settings-store updateUserSettingsOverrides', () => {
  const originalBackend = process.env.SETTINGS_BACKEND

  afterEach(async () => {
    Sinon.restore()
    await settingsStore.shutdownSettingsStore()

    if (originalBackend === undefined) {
      delete process.env.SETTINGS_BACKEND
    } else {
      process.env.SETTINGS_BACKEND = originalBackend
    }
  })

  it('serializes overlapping file-backend updates', async () => {
    delete process.env.SETTINGS_BACKEND
    const saveSettings = Sinon.stub(settingsConfig, 'saveSettings')

    await Promise.all([
      settingsStore.updateUserSettingsOverrides((current) =>
        ({
          ...current,
          info: { relay_url: 'wss://a.example', name: 'A' },
        }) as any,
      ),
      settingsStore.updateUserSettingsOverrides((current) =>
        ({
          ...current,
          info: { relay_url: 'wss://b.example', name: 'B' },
        }) as any,
      ),
    ])

    expect(saveSettings.callCount).to.equal(2)
    const secondSaved = saveSettings.secondCall.args[0] as { info?: { name?: string } }
    expect(secondSaved.info?.name).to.equal('B')
  })
})

describe('handleSettingsOverridesClusterSyncFromWorker', () => {
  const originalBackend = process.env.SETTINGS_BACKEND

  afterEach(() => {
    Sinon.restore()
    if (originalBackend === undefined) {
      delete process.env.SETTINGS_BACKEND
    } else {
      process.env.SETTINGS_BACKEND = originalBackend
    }
  })

  it('reloads on the primary and notifies other workers', async () => {
    process.env.SETTINGS_BACKEND = 'db'
    Sinon.stub(cluster, 'isPrimary').value(true)

    const reload = Sinon.stub(settingsStore, 'reloadDbOverridesFromDatabase').resolves()
    const source = { id: 1 } as Worker
    const notifiedWorker = { id: 2, send: Sinon.stub() }
    const sourceWorker = { id: 1, send: Sinon.stub() }
    Sinon.stub(cluster, 'workers').value({
      1: sourceWorker,
      2: notifiedWorker,
    })

    await settingsStore.handleSettingsOverridesClusterSyncFromWorker(source)

    expect(reload.calledOnce).to.equal(true)
    expect(
      notifiedWorker.send.calledOnceWith({
        eventName: settingsStore.SETTINGS_OVERRIDES_RELOAD_EVENT,
      }),
    ).to.equal(true)
    expect(sourceWorker.send.called).to.equal(false)
  })
})
