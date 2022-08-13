import { IncomingMessage, Server, ServerResponse } from 'http'
import { Duplex, EventEmitter } from 'stream'

import packageJson from '../../package.json'
import { Settings } from '../settings'
import { IWebServerAdapter } from '../@types/adapters'

export class WebServerAdapter extends EventEmitter implements IWebServerAdapter {

  public constructor(
    private readonly webServer: Server,
  ) {
    super()
    this.webServer.on('request', this.onWebServerRequest.bind(this))
    this.webServer.on('clientError', this.onWebServerSocketError.bind(this))
    this.webServer.on('close', this.onClose.bind(this))
  }

  public listen(port: number): void {
    console.log('Listening on port:', port)
    this.webServer.listen(port)
  }

  private onWebServerRequest(request: IncomingMessage, response: ServerResponse) {
    if (request.method === 'GET' && request.headers['accept'] === 'application/nostr+json') {
      const {
        info: { name, description, pubkey, contact },
      } = Settings

      const relayInformationDocument = {
        name,
        description,
        pubkey,
        contact,
        supported_nips: [11, 12, 15, 16],
        software: packageJson.repository.url,
        version: packageJson.version,
      }

      response.setHeader('content-type', 'application/nostr+json')
      response.end(JSON.stringify(relayInformationDocument))
    } else {
      response.setHeader('content-type', 'application/text')
      response.end('Please use a Nostr client to connect.')
    }
  }

  private onWebServerSocketError(error: Error, socket: Duplex) {
    if (error['code'] === 'ECONNRESET' || !socket.writable) {
      return
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  }

  private onClose() {
    console.log('web server closing')
    this.webServer.removeAllListeners()
  }
}
