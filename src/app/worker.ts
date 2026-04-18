import { IRunnable } from '../@types/base'
import { IWebSocketServerAdapter } from '../@types/adapters'

import { closeCacheClient } from '../cache/client'
import { createLogger } from '../factories/logger-factory'
import { FSWatcher } from 'fs'
import { SettingsStatic } from '../utils/settings'

const logger = createLogger('app-worker')
export class AppWorker implements IRunnable {
  private watchers: FSWatcher[] | undefined

  public constructor(
    private readonly process: NodeJS.Process,
    private readonly adapter: IWebSocketServerAdapter,
  ) {
    this.process
      .on('message', this.onMessage.bind(this))
      .on('SIGINT', this.onExit.bind(this))
      .on('SIGHUP', this.onExit.bind(this))
      .on('SIGTERM', this.onExit.bind(this))
      .on('uncaughtException', this.onError.bind(this))
      .on('unhandledRejection', this.onError.bind(this))
  }

  public run(): void {
    this.watchers = SettingsStatic.watchSettings()

    const port = process.env.PORT || process.env.RELAY_PORT || 8008
    this.adapter.listen(typeof port === 'number' ? port : Number(port))
  }

  private onMessage(message: { eventName: string; event: unknown }): void {
    this.adapter.emit(message.eventName, message.event)
  }

  private onError(error: Error) {
    if (error.name === 'TypeError' && error.message === "Cannot read properties of undefined (reading '__knexUid')") {
      logger.error(
        'Unable to acquire connection. Please increase DB_MAX_POOL_SIZE, DB_ACQUIRE_CONNECTION_TIMEOUT and tune postgresql.conf to make use of server\'s resources.'
      )
      return
    }
    logger.error('uncaught error:', error)
  }

  private onExit() {
    logger('exiting')
    this.close(() => {
      this.process.exit(0)
    })
  }

  public close(callback?: () => void) {
    logger('closing')
    if (Array.isArray(this.watchers)) {
      for (const watcher of this.watchers) {
        watcher.close()
      }
    }
    this.adapter.close(async () => {
      await closeCacheClient()
      callback?.()
    })
    logger('closed')
  }
}
