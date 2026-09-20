import chai from 'chai'

import {
  getMergedAdminNotifications,
  mergeAdminNotificationsPatch,
} from '../../../src/utils/admin-notifications-settings'

const { expect } = chai

describe('admin-notifications-settings', () => {
  it('merges patch values and preserves redacted webhook secrets', () => {
    const current = getMergedAdminNotifications({
      admin: {
        notifications: {
          enabled: true,
          targets: [
            {
              id: 'discord-1',
              type: 'discord',
              enabled: true,
              url: 'https://discord.com/api/webhooks/secret',
            },
          ],
          events: { 'settings.changed': true },
          retry: { maxAttempts: 5, baseDelayMs: 1000 },
        },
      },
    } as any)

    const next = mergeAdminNotificationsPatch(current, {
      targets: [
        {
          id: 'discord-1',
          type: 'discord',
          enabled: false,
          url: '***',
        },
      ],
    })

    expect(next.targets[0].enabled).to.equal(false)
    expect(next.targets[0].url).to.equal('https://discord.com/api/webhooks/secret')
  })
})
