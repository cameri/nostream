import { expect } from 'chai'

import { flattenSettingsToPaths, getByPath, setByPath } from '../../../src/utils/settings-config'

describe('flattenSettingsToPaths', () => {
  it('flattens nested objects into dot paths', () => {
    expect(
      flattenSettingsToPaths({
        info: { name: 'Relay', relay_url: 'wss://relay.example.com' },
        nip66: { enabled: true },
      }),
    ).to.deep.equal([
      { path: 'info.name', value: 'Relay' },
      { path: 'info.relay_url', value: 'wss://relay.example.com' },
      { path: 'nip66.enabled', value: true },
    ])
  })

  it('preserves notification event keys that contain dots', () => {
    expect(
      flattenSettingsToPaths({
        admin: {
          notifications: {
            events: { 'settings.changed': true, 'mirror.disconnected': false },
          },
        },
      }),
    ).to.deep.equal([
      { path: 'admin.notifications.events["settings.changed"]', value: true },
      { path: 'admin.notifications.events["mirror.disconnected"]', value: false },
    ])
  })

  it('stores empty arrays as explicit override rows', () => {
    expect(
      flattenSettingsToPaths({
        limits: {
          message: {
            ipWhitelist: [],
          },
        },
      }),
    ).to.deep.equal([{ path: 'limits.message.ipWhitelist', value: [] }])
  })

  it('flattens indexed array paths', () => {
    expect(
      flattenSettingsToPaths({
        nip66: {
          targets: ['wss://relay.example.com'],
        },
      }),
    ).to.deep.equal([{ path: 'nip66.targets[0]', value: 'wss://relay.example.com' }])
  })

  it('round-trips dotted notification keys through setByPath', () => {
    const source = {
      admin: {
        notifications: {
          events: { 'settings.changed': true, 'mirror.disconnected': false },
          targets: [{ id: 'ops', type: 'http', url: 'https://example.com/hook' }],
        },
      },
    }

    let rebuilt: Record<string, unknown> = {}
    for (const entry of flattenSettingsToPaths(source)) {
      rebuilt = setByPath(rebuilt, entry.path, entry.value)
    }

    expect(getByPath(rebuilt, 'admin.notifications.events["settings.changed"]')).to.equal(true)
    expect(getByPath(rebuilt, 'admin.notifications.targets[0].id')).to.equal('ops')
    expect(rebuilt).to.deep.equal(source)
  })
})
