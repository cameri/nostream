import { After, Before, Given, When } from '@cucumber/cucumber'
import { assocPath, pipe } from 'ramda'
import { createClient } from 'redis'
import { WebSocket } from 'ws'

import { createEvent } from '../helpers'
import { Event } from '../../../../src/@types/event'
import { getCacheConfig } from '../../../../src/cache/client'
import { SettingsStatic } from '../../../../src/utils/settings'

let testCacheClient: any
const rateLimitKeys: string[] = []

Before({ tags: '@rate-limiter' }, async function() {
  testCacheClient = createClient(getCacheConfig())
  await testCacheClient.connect()
  SettingsStatic._settings = pipe(
    assocPath(['limits', 'rateLimiter', 'strategy'], 'ewma'),
    assocPath(['limits', 'message', 'rateLimits'], [{ period: 60000, rate: 10 }]),
    assocPath(['limits', 'message', 'ipWhitelist'], []),
  )(SettingsStatic._settings) as any
})

Given(/(\w+)'s message rate is already at the limit/, async function(name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const address = (ws as any)._socket?.remoteAddress ?? '::1'
  const period = 60000
  const key = `${address}:message:${period}`

  await testCacheClient.hSet(key, {
    rate: '999',
    timestamp: Date.now().toString(),
  })

  rateLimitKeys.push(key)
})

When(/(\w+) sends a text_note event expecting to be rate limited/, async function(name: string) {
  const ws = this.parameters.clients[name] as WebSocket
  const { pubkey, privkey } = this.parameters.identities[name]

  const event: Event = await createEvent({ pubkey, kind: 1, content: 'hello' }, privkey)

  await new Promise<void>((resolve, reject) => {
    ws.send(JSON.stringify(['EVENT', event]), (err) => {
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    })
  })

  this.parameters.events[name].push(event)
})

After({ tags: '@rate-limiter' }, async function() {
  SettingsStatic._settings = pipe(
    assocPath(['limits', 'message', 'rateLimits'], []),
    assocPath(['limits', 'message', 'ipWhitelist'], ['::1', '10.10.10.1', '::ffff:10.10.10.1']),
  )(SettingsStatic._settings) as any

  for (const key of rateLimitKeys) {
    await testCacheClient.del(key)
  }
  rateLimitKeys.length = 0
  await testCacheClient.disconnect()
})
