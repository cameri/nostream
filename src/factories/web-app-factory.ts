import express, { Express } from 'express'
import { randomBytes } from 'crypto'

import { createSettings } from './settings-factory'
import router from '../routes'
import { getGrafanaFrameOrigin } from '../utils/admin-grafana'

// Extracted so the ws:/wss: -> http:/https: mapping can be unit tested directly,
// without needing to exercise the full Express middleware stack.
export const getWebProtocolForRelay = (relayProtocol: string): string => (relayProtocol === 'wss:' ? 'https:' : 'http:')

export const createWebApp = (): Express => {
  const app = express()
  app
    .disable('x-powered-by')
    .use((req, res, next) => {
      const settings = createSettings()
      const nonce = randomBytes(16).toString('base64')
      res.locals.nonce = nonce

      const relayUrl = new URL(settings.info.relay_url)
      const webRelayUrl = new URL(relayUrl.toString())
      webRelayUrl.protocol = getWebProtocolForRelay(relayUrl.protocol)

      const directives = {
        'img-src': ["'self'", 'data:', 'https://cdn.zebedee.io/an/nostr/'],
        'connect-src': ["'self'", settings.info.relay_url as string, webRelayUrl.toString()],
        'default-src': ["'self'"],
        'frame-src': ["'self'", getGrafanaFrameOrigin()],
        'script-src-attr': [`'nonce-${nonce}'`],
        'script-src': [
          "'self'",
          `'nonce-${nonce}'`,
          'https://cdn.jsdelivr.net/npm/',
          'https://unpkg.com/',
          'https://cdnjs.cloudflare.com/ajax/libs/',
        ],
        'style-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
        'font-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
      }

      const csp = Object.entries(directives)
        .map(([key, values]) => `${key} ${values.join(' ')}`)
        .join('; ')
      res.setHeader('Content-Security-Policy', csp)
      return next()
    })
    .use('/favicon.ico', express.static('./resources/favicon.ico'))
    .use('/css', express.static('./resources/css'))

  app.use(router)

  return app
}
