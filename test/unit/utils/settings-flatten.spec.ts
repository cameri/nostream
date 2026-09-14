import { expect } from 'chai'

import { flattenSettingsToPaths } from '../../../src/utils/settings-config'

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

  it('flattens indexed array paths', () => {
    expect(
      flattenSettingsToPaths({
        nip66: {
          targets: ['wss://relay.example.com'],
        },
      }),
    ).to.deep.equal([{ path: 'nip66.targets[0]', value: 'wss://relay.example.com' }])
  })
})
