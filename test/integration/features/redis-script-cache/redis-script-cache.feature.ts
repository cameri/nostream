import { Before, When } from '@cucumber/cucumber'
import { assocPath, pipe } from 'ramda'
import { createClient } from 'redis'

import { getCacheConfig } from '../../../../src/cache/client'
import { SettingsStatic } from '../../../../src/utils/settings'

// The relay only touches Lua when a rate limit is configured: both limiters
// return early on an empty list. A scenario that never configures one would pass
// whether or not the EVALSHA fallback exists, which is the definition of a test
// that proves nothing. A generous limit keeps the window from tripping while
// still forcing the script through `EVALSHA`.
Before({ tags: '@script-cache' }, async function () {
  SettingsStatic._settings = pipe(
    assocPath(['limits', 'rateLimiter', 'strategy'], 'ewma'),
    assocPath(['limits', 'message', 'rateLimits'], [{ period: 60000, rate: 100 }]),
    assocPath(['limits', 'message', 'ipWhitelist'], []),
  )(SettingsStatic._settings) as any
})

// `SCRIPT FLUSH` is the whole of a Redis restart as far as the relay can tell:
// the script cache is memory-resident and empty, so the next EVALSHA answers
// NOSCRIPT. Doing it this way keeps the scenario deterministic — no container
// to restart, no reconnect to wait for, and it exercises the adapter's retry
// rather than the client's reconnect logic.
When(/^the cache forgets its stored Lua scripts$/, async function () {
  const client = createClient(getCacheConfig())
  await client.connect()

  try {
    await client.sendCommand(['SCRIPT', 'FLUSH'])
  } finally {
    await client.quit()
  }
})
