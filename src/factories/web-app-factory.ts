import express from 'express'
import helmet from 'helmet'

import { createLogger } from './logger-factory'
import { createSettings } from './settings-factory'
import router from '../routes'

const debug = createLogger('web-app-factory')

export const createWebApp = () => {
  const app = express()
  app
    .disable('x-powered-by')
    .use((req, res, next) => {
      const settings = createSettings()

      const relayUrl = new URL(settings.info.relay_url)
      const webRelayUrl = new URL(relayUrl.toString())
      webRelayUrl.protocol = (relayUrl.protocol === 'wss:') ? 'https:' : ':'

      const directives = {
        /**
         * TODO: Remove 'unsafe-inline'
         */
        'img-src': ["'self'", 'data:', 'https://cdn.zebedee.io/an/nostr/'],
        'connect-src': ["'self'", settings.info.relay_url as string, webRelayUrl.toString()],
        'default-src': ["'self'"],
        'script-src-attr': ["'unsafe-inline'"],
        'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net/npm/', 'https://unpkg.com/', 'https://cdnjs.cloudflare.com/ajax/libs/'],
        'style-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
        'font-src': ["'self'", 'https://cdn.jsdelivr.net/npm/'],
      }

      debug('CSP directives: %o', directives)

      return helmet.contentSecurityPolicy({ directives })(req, res, next)
    })
    .use('/favicon.ico', express.static('./resources/favicon.ico'))
    .use('/css', express.static('./resources/css'))
    .use(router)

  return app
}