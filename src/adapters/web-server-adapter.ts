import { Duplex, EventEmitter } from 'stream'
import { Server } from 'http'

import { createLogger } from '../factories/logger-factory'
import { IWebServerAdapter } from '../@types/adapters'

const debug = createLogger('web-server-adapter')

export class WebServerAdapter extends EventEmitter implements IWebServerAdapter {
  public constructor(
    protected readonly webServer: Server,
  ) {
    debug('created')
    super()
    this.webServer
      .on('error', this.onError.bind(this))
      .on('clientError', this.onClientError.bind(this))
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

  private onError(error: Error) {
    console.error('web-server-adapter: error:', error)
  }

  private onClientError(error: Error, socket: Duplex) {
    if (error['code'] === 'ECONNRESET' || !socket.writable) {
      return
    }
    console.error('web-server-adapter: client socket error:', error)
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\n')
  }

  public close(callback?: () => void): void {
    debug('closing')
    this.webServer.close(() => {
      this.webServer.removeAllListeners()
      this.removeAllListeners()
      if (typeof callback !== 'undefined') {
        callback()
      }
    })
    debug('closed')
  }

  protected onClose() {
    debug('stopped listening to incoming connections')
  }
}
