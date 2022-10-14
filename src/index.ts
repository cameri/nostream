import cluster, { Worker } from 'cluster'
import { cpus } from 'os'
import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { EventRepository } from './repositories/event-repository'
import { getDbClient } from './database/client'
import { saveSettingsOnExit } from './utils/settings'
import { webSocketAdapterFactory } from './factories/websocket-adapter-factory'
import { WebSocketServerAdapter } from './adapters/web-socket-server-adapter'

const newWorker = (): Worker => {
  return cluster.fork()
}

if (cluster.isPrimary) {
  console.log(`primary ${process.pid} - running`)

  const numCpus = cpus().length

  for (let i = 0; i < numCpus; i++) {
    newWorker()
  }

  cluster.on('exit', (deadWorker, code, signal) => {
    console.log(`worker ${deadWorker.process.pid} - exiting`)
    if (code === 0 || signal === 'SIGINT') {
      return
    }
    const worker = newWorker()

    const newPID = worker.process.pid
    const oldPID = deadWorker.process.pid

    console.log('worker ' + oldPID + ' died.')
    console.log('worker ' + newPID + ' born.')
  })

  const exitHandler = () => {
    console.log('Primary exiting')

    saveSettingsOnExit()

    process.exit(0)
  }

  cluster.on('message', (source, message) => {
    for (const worker of Object.values(cluster.workers)) {
      if (source.id === worker.id) {
        continue
      }

      worker.send(message)
    }
  })

  process.on('SIGINT', exitHandler)
  process.on('uncaughtException', exitHandler)
} else if (cluster.isWorker) {
  const port = Number(process.env.SERVER_PORT) || 8008

  const dbClient = getDbClient()
  const eventRepository = new EventRepository(dbClient)

  const server = http.createServer()
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
  const adapter = new WebSocketServerAdapter(
    server,
    wss,
    webSocketAdapterFactory(eventRepository)
  )

  adapter.listen(port)

  const exitHandler = () => {
    wss.close(() => {
      server.close(() => {
        dbClient.destroy(() => {
          process.exit(0)
        })
      })
    })
  }

  process.on('SIGINT', exitHandler)
  process.on('uncaughtException', exitHandler)

  process.on('message', (message: { eventName: string, event: unknown }) => {
    adapter.emit(message.eventName, message.event)
  })

  console.log(`worker ${process.pid} - listening on port ${port}`)
}
