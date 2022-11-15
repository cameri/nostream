import { Duplex, EventEmitter } from 'stream'
import { IncomingMessage, Server, ServerResponse } from 'http'

import packageJson from '../../package.json'

import { createLogger } from '../factories/logger-factory'
import { ISettings } from '../@types/settings'
import { IWebServerAdapter } from '../@types/adapters'

const debug = createLogger('web-server-adapter')

export class WebServerAdapter extends EventEmitter implements IWebServerAdapter {
  public constructor(
    protected readonly webServer: Server,
    private readonly settings: () => ISettings,
  ) {
    debug('web server starting')
    super()
    this.webServer
      .on('request', this.onRequest.bind(this))
      .on('clientError', this.onError.bind(this))
      .once('close', this.onClose.bind(this))
      .once('listening', this.onListening.bind(this))
  }

  public listen(port: number): void {
    debug('attempt to listen on port %d', port)
    this.webServer.listen(port)
  }

  private onListening() {
    debug('listening for incoming connections')
  }

  private onRequest(request: IncomingMessage, response: ServerResponse) {
    debug('request received: %O', request.headers)
    if (request.method === 'GET' && request.headers['accept'] === 'application/nostr+json') {
      const {
        info: { name, description, pubkey, contact },
      } = this.settings()

      const relayInformationDocument = {
        name,
        description,
        pubkey,
        contact,
        supported_nips: packageJson.supportedNips,
        software: packageJson.repository.url,
        version: packageJson.version,
      }

      response.setHeader('content-type', 'application/nostr+json')
      const body = JSON.stringify(relayInformationDocument)
      response.end(body)
    } else {
      response.setHeader('content-type', 'application/text')
      response.end('Please use a Nostr client to connect.')
    }
  }

  private onError(error: Error, socket: Duplex) {
    debug('socket error: %o', error)
    if (error['code'] === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  }

  protected onClose() {
    debug('stopped listening to incoming connections')
    this.webServer.removeAllListeners()
  }
}
