import net from 'net'
import { readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

import { createLogger } from '../factories/logger-factory'
import { TorConfig } from '../@types/tor'

const logger = createLogger('tor-client')

const getPrivateKeyFile = () => {
  return join(process.env.NOSTR_CONFIG_DIR ?? join(homedir(), '.nostr'), 'v3_onion_private_key')
}

export const createTorConfig = (): TorConfig => {
  return {
    host: process.env.TOR_HOST,
    port: process.env.TOR_CONTROL_PORT ? Number(process.env.TOR_CONTROL_PORT) : 9051,
    password: process.env.TOR_PASSWORD,
  }
}

type OnionResult = { ServiceID?: string; PrivateKey?: string }

export class TorClient {
  private socket: net.Socket | undefined
  private readonly host: string
  private readonly port: number
  private readonly password: string

  constructor({ host, port, password }: { host?: string; port?: number; password?: string } = {}) {
    this.host = host ?? 'localhost'
    this.port = port ?? 9051
    this.password = password ?? ''
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.connect({ host: this.host, port: this.port })
      this.socket.once('error', reject)
      this.socket.once('data', (data) => {
        if (/^250/.test(data.toString())) { resolve() }
        else { reject(new Error(`Tor auth failed: ${data}`)) }
      })
      this.socket.write(`AUTHENTICATE "${this.password}"\r\n`)
    })
  }

  private isCompleteTorReply(buffer: string): boolean {
    if (!buffer.endsWith('\r\n')) {
      return false
    }

    const lines = buffer.split('\r\n')
    if (lines[lines.length - 1] === '') {
      lines.pop()
    }

    if (lines.length === 0) {
      return false
    }

    const firstLine = lines[0].match(/^(\d{3})([\s\-+])/)
    if (!firstLine) {
      return false
    }

    const statusCode = firstLine[1]
    let inDataBlock = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (inDataBlock) {
        if (line === '.') {
          inDataBlock = false
        }
        continue
      }

      const match = line.match(/^(\d{3})([\s\-+])/)
      if (!match || match[1] !== statusCode) {
        return false
      }

      if (match[2] === ' ') {
        return i === lines.length - 1
      }

      if (match[2] === '+') {
        inDataBlock = true
      }
    }

    return false
  }

  private sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected to Tor control port'))
        return
      }

      const socket = this.socket
      let buf = ''

      const cleanup = () => {
        socket.off('data', onData)
        socket.off('error', onError)
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const onData = (data: Buffer) => {
        buf += data.toString()
        if (!this.isCompleteTorReply(buf)) {
          return
        }

        cleanup()
        if (/^250/.test(buf)) { resolve(buf) }
        else { reject(new Error(buf.trim())) }
      }

      socket.on('data', onData)
      socket.on('error', onError)
      socket.write(`${command}\r\n`)
    })
  }

  async addOnion(port: number, host?: string, privateKey?: string | null): Promise<OnionResult> {
    const key = privateKey ?? 'NEW:BEST'
    const portSpec = host !== undefined ? `${port},${host}:${port}` : `${port}`
    const response = await this.sendCommand(`ADD_ONION ${key} Port=${portSpec}`)

    const result: OnionResult = {}
    for (const line of response.split('\r\n')) {
      const m = line.match(/^250[-\s](\w+)=(.+)$/)
      if (m) { (result as Record<string, string>)[m[1]] = m[2] }
    }
    if (result.ServiceID) { result.ServiceID += '.onion' }
    if (!result.PrivateKey && privateKey) { result.PrivateKey = privateKey }
    return result
  }

  async quit(): Promise<void> {
    await this.sendCommand('QUIT').catch(() => undefined)
    this.socket?.destroy()
    this.socket = undefined
  }
}

let client: TorClient | undefined

export const getTorClient = async () => {
  if (!client) {
    const config = createTorConfig()
    logger('config: %o', config)

    if (config.host !== undefined) {
      logger('connecting')
      client = new TorClient(config)
      try {
        await client.connect()
      } catch (_error) {
        client = undefined
      }
      logger('connected')
    }
  }

  return client
}
export const closeTorClient = async () => {
  if (client) {
    await client.quit()
    client = undefined
  }
}

export const addOnion = async (port: number, host?: string): Promise<string> => {
  let privateKey = null
  const path = getPrivateKeyFile()

  try {
    logger('reading private key from %s', path)
    const data = await readFile(path, 'utf8')
    if (data?.length) {
      privateKey = data
      logger('privateKey: %o', privateKey)
    }
  } catch (error) {
    logger('error reading private key: %o', error)
  }

  const client = await getTorClient()
  if (client) {
    const hiddenService = await client.addOnion(port, host, privateKey)
    logger('hidden service: %s:%d', hiddenService.ServiceID, port)

    if (hiddenService?.PrivateKey) {
      logger.info('saving private key to %s', path)

      await writeFile(path, hiddenService.PrivateKey, 'utf8')
      return hiddenService.ServiceID!
    } else {
      throw new Error(JSON.stringify(hiddenService))
    }
  } else {
    throw new Error('not connect')
  }
}
