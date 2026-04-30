import fs from 'fs'
import knex from 'knex'

import packageJson from '../../../package.json'
import { loadMergedSettings } from '../utils/config'
import { logError, logInfo } from '../utils/output'
import { getOnionKeyPath, getTorHostnamePath } from '../utils/bootstrap'
import { getProjectPath } from '../utils/paths'
import { runCommandWithOutput } from '../utils/process'

type InfoOptions = {
  torHostname?: boolean
  i2pHostname?: boolean
  json?: boolean
}

type I2PGuidancePayload = {
  i2pHostnames: string[]
  keysFile: string
  guidance?: {
    webConsoleUrl: string
    consoleQueryCommand: string
  }
}

const getEventCount = async (): Promise<number | null> => {
  const db = knex({
    client: 'pg',
    connection: process.env.DB_URI
      ? process.env.DB_URI
      : {
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
        },
    pool: {
      min: 0,
      max: 1,
      idleTimeoutMillis: 1000,
      acquireTimeoutMillis: 1000,
      propagateCreateError: false,
    },
    acquireConnectionTimeout: 1000,
  } as any)

  try {
    const result = await db('events').whereNull('deleted_at').count<{ count: string | number }>('* as count').first()
    return Number(result?.count ?? 0)
  } catch {
    return null
  } finally {
    await db.destroy()
  }
}

const getRelayUptimeSeconds = async (): Promise<number | null> => {
  let idResult: { code: number; stdout: string; stderr: string }
  try {
    idResult = await runCommandWithOutput('docker', ['compose', 'ps', '-q', 'nostream'], { timeoutMs: 1000 })
  } catch {
    return null
  }
  if (idResult.code !== 0) {
    return null
  }

  const containerId = idResult.stdout.trim()
  if (!containerId) {
    return null
  }

  const startedAtResult = await runCommandWithOutput('docker', ['inspect', '--format', '{{.State.StartedAt}}', containerId], {
    timeoutMs: 1000,
  })
  if (startedAtResult.code !== 0) {
    return null
  }

  const startedAtRaw = startedAtResult.stdout.trim()
  const startedAtMs = Date.parse(startedAtRaw)
  if (!Number.isFinite(startedAtMs)) {
    return null
  }

  const seconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
  return seconds
}

const formatUptime = (uptimeSeconds: number | null): string => {
  if (uptimeSeconds === null) {
    return 'unavailable'
  }

  const days = Math.floor(uptimeSeconds / 86400)
  const hours = Math.floor((uptimeSeconds % 86400) / 3600)
  const minutes = Math.floor((uptimeSeconds % 3600) / 60)
  const seconds = uptimeSeconds % 60

  const segments = []
  if (days > 0) {
    segments.push(`${days}d`)
  }
  if (hours > 0 || days > 0) {
    segments.push(`${hours}h`)
  }
  if (minutes > 0 || hours > 0 || days > 0) {
    segments.push(`${minutes}m`)
  }
  segments.push(`${seconds}s`)
  return segments.join(' ')
}

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const writeJsonError = (message: string, code = 1): void => {
  process.stderr.write(`${JSON.stringify({ error: { message, code } })}\n`)
}

export const getInfoPayload = async () => {
  const settings = loadMergedSettings()
  const torHostnamePath = getTorHostnamePath()
  const torHostname = fs.existsSync(torHostnamePath) ? fs.readFileSync(torHostnamePath, 'utf-8').trim() : null
  const [eventCount, uptimeSeconds] = await Promise.all([getEventCount(), getRelayUptimeSeconds()])

  return {
    version: packageJson.version,
    relay: {
      name: settings.info?.name,
      url: settings.info?.relay_url,
      pubkey: settings.info?.pubkey,
      paymentsEnabled: settings.payments?.enabled ?? false,
      paymentProcessor: settings.payments?.processor ?? null,
    },
    tor: {
      hostname: torHostname,
      onionPrivateKeyPath: getOnionKeyPath(),
    },
    runtime: {
      eventCount,
      uptimeSeconds,
    },
  }
}

export const runInfo = async (options: InfoOptions): Promise<number> => {
  const payload = await getInfoPayload()

  if (options.torHostname) {
    if (payload.tor.hostname) {
      if (options.json) {
        writeJson({ torHostname: payload.tor.hostname })
        return 0
      }

      logInfo(payload.tor.hostname)
      return 0
    }

    if (options.json) {
      process.stderr.write(
        `${JSON.stringify({ error: { message: 'Tor hostname not found. Start with `nostream start --tor` first.', code: 1 } })}\n`,
      )
      return 1
    }

    logError('Tor hostname not found. Start with `nostream start --tor` first.')
    return 1
  }

  if (options.i2pHostname) {
    const keysFile = getProjectPath('.nostr', 'i2p', 'data', 'nostream.dat')
    const i2pGuidance: I2PGuidancePayload = {
      i2pHostnames: [],
      keysFile,
      guidance: {
        webConsoleUrl: 'http://127.0.0.1:7070/?page=i2p_tunnels',
        consoleQueryCommand:
          "docker exec i2pd wget -qO- 'http://127.0.0.1:7070/?page=i2p_tunnels' | grep -oE '[a-z2-7]{52}\\\\.b32\\\\.i2p' | sort -u",
      },
    }

    if (!fs.existsSync(keysFile)) {
      if (options.json) {
        writeJsonError(`I2P destination keys not found. Is the i2pd container running? Expected: ${keysFile}`)
        return 1
      }

      logError('I2P destination keys not found. Is the i2pd container running?')
      logError(`Expected: ${keysFile}`)
      return 1
    }

    const result = await runCommandWithOutput('docker', [
      'exec',
      'i2pd',
      'wget',
      '-qO-',
      'http://127.0.0.1:7070/?page=i2p_tunnels',
    ])

    const matches = new Set((`${result.stdout}\n${result.stderr}`).match(/[a-z2-7]{52}\.b32\.i2p/g) ?? [])
    if (matches.size > 0) {
      if (options.json) {
        writeJson({
          i2pHostnames: [...matches],
        })
        return 0
      }

      for (const hostname of matches) {
        logInfo(hostname)
      }
      return 0
    }

    if (options.json) {
      writeJson(i2pGuidance)
      return 0
    }

    logInfo(`I2P destination keys exist at: ${keysFile}`)
    logInfo('')
    logInfo('To find your nostream .b32.i2p address, use one of these methods:')
    logInfo('  1. Open the i2pd web console: http://127.0.0.1:7070/?page=i2p_tunnels')
    logInfo('     (published by docker-compose.i2p.yml, bound to 127.0.0.1 only)')
    logInfo('  2. Query the console from inside the container:')
    logInfo("     docker exec i2pd wget -qO- 'http://127.0.0.1:7070/?page=i2p_tunnels' \\")
    logInfo("       | grep -oE '[a-z2-7]{52}\\\\.b32\\\\.i2p' | sort -u")
    return 0
  }

  if (options.json) {
    writeJson(payload)
    return 0
  }

  logInfo(`Nostream v${payload.version}`)
  logInfo(`Relay: ${payload.relay.name ?? 'n/a'} (${payload.relay.url ?? 'n/a'})`)
  logInfo(`Pubkey: ${payload.relay.pubkey ?? 'n/a'}`)
  logInfo(`Payments: ${payload.relay.paymentsEnabled ? `enabled (${payload.relay.paymentProcessor})` : 'disabled'}`)
  logInfo(`Tor hostname: ${payload.tor.hostname ?? 'not found'}`)
  logInfo(`Onion key path: ${payload.tor.onionPrivateKeyPath}`)
  logInfo(`Events: ${payload.runtime.eventCount ?? 'unavailable'}`)
  logInfo(`Uptime: ${formatUptime(payload.runtime.uptimeSeconds)}`)

  return 0
}
