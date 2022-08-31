import cluster, { Worker } from 'cluster'
import { cpus } from 'os'
import http from 'http'
import process from 'process'
import { WebSocketServer } from 'ws'

import { EventRepository } from './repositories/event-repository'
import { getDbClient } from './database/client'
import { webSocketAdapterFactory } from './factories/websocket-adapter-factory'
import { WebSocketServerAdapter } from './adapters/web-socket-server-adapter'

const dbClient = getDbClient()
const eventRepository = new EventRepository(dbClient)

const numCpus = cpus().length
const port = Number(process.env.SERVER_PORT) || 8008


const newWorker = (): Worker => {
  let timeout
  const worker = cluster.fork()
  worker
    .on('listening', () => {
      console.log(`worker ${worker.process.pid} listening`)
      // worker.send('shutdown')
      // worker.disconnect()
      // timeout = setTimeout(() => {
      //   worker.kill()
      // }, 5000)
    })
    .on('disconnect', () => {
      console.log(`worker ${worker.process.pid} disconnect`)
      clearTimeout(timeout)
    })
    .on('exit', (code, signal) => {
      console.log(`worker ${worker.process.pid} died with code ${code} and signal ${signal}`)
    })

  return worker
}

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`)

  for (let i = 0; i < numCpus; i++) {
    newWorker()
  }

  cluster.on('exit', (deadWorker) => {
    const worker = newWorker()

    // Note the process IDs
    const newPID = worker.process.pid
    const oldPID = deadWorker.process.pid

    // Log the event
    console.log('worker ' + oldPID + ' died.')
    console.log('worker ' + newPID + ' born.')
  })

  process.on('SIGINT', function () {
    console.log('\rCaught interrupt signal')

    //await Promise.all(apps.map((app) => app.terminate()))
    // for (const id in cluster.workers) {
    //   apps.get(cluster.workers[id])
    // }

    // await new Promise((resolve, reject) =>
    //   wss.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
    // )
    // await new Promise((resolve, reject) =>
    //   server.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
    // )

    for (const id in cluster.workers) {
      console.log('id', id)
      console.log(`shutting down worker ${cluster.workers[id].process.pid}`)
      cluster.workers[id].send('shutdown')
    }

    console.log('Disconnecting from db')
    dbClient.destroy(() => {
      console.log('Exiting')
      process.exit()
    })
  })
} else if (cluster.isWorker) {

  const server = http.createServer()
  const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 })
  const adapter = new WebSocketServerAdapter(
    server,
    wss,
    webSocketAdapterFactory(eventRepository)
  )

  adapter.listen(port)

  process.on('message', async (msg) => {
    console.log('worker received', msg)
    if (msg === 'shutdown') {
      console.log('disconnecting all clients')
      wss.clients.forEach((client) => client.terminate())
      wss.close()
      // server.close()
      // await new Promise((resolve, reject) =>
      //   wss.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
      // )
      // await new Promise((resolve, reject) =>
      //   server.close((error?: Error) => void (error instanceof Error) ? reject(error) : resolve(undefined))
      // )
    }
  })

  console.log(`Worker ${process.pid} started and listening on port ${port}`)
}
