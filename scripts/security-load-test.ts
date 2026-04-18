#!/usr/bin/env node
/**
 * security-load-test.ts
 *
 * A generalized load testing and security emulation tool for Nostream.
 * Simulates a combined Slowloris (Zombie) attack and an Event Flood attack.
 *
 * Features:
 * 1. Zombie Connections: Opens connections, subscribes, and silences pongs.
 * 2. Active Spammer: Generates and publishes valid NOSTR events (signed via secp256k1).
 *
 * Usage:
 *   npx ts-node scripts/security-load-test.ts [--url ws://localhost:8008] [--zombies 5000] [--spam-rate 100]
 *
 * Alternate (via npm):
 *   npm run test:load -- --zombies 5000
 */

import WebSocket from 'ws'
import * as crypto from 'crypto'
import * as secp256k1 from '@noble/secp256k1'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Parsed key-value map from CLI --flag value pairs. */
type CliArgs = Record<string, string>

/** A valid serialised Nostr event (NIP-01). */
interface NostrEvent {
    id: string
    pubkey: string
    created_at: number
    kind: number
    tags: string[][]
    content: string
    sig: string
}

/**
 * The `ws` package exposes a private `_receiver` property on WebSocket
 * instances that is used internally for frame parsing and ping/pong handling.
 * We cast to this interface to suppress pong responses in zombie connections.
 */
interface WebSocketWithReceiver extends WebSocket {
    _receiver?: {
        removeAllListeners(event: string): void
        on(event: string, listener: () => void): void
    }
    /** Override the built-in pong helper to become a no-op. */
    pong: (...args: unknown[]) => void
}

// ── CLI Args ─────────────────────────────────────────────────────────────────

function parseCliArgs(argv: string[]): CliArgs {
    const acc: CliArgs = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (!arg.startsWith('--')) continue

        const key: string = arg.slice(2)
        const value: string | undefined = argv[i + 1]

        if (value === undefined || value.startsWith('--')) {
            console.error(`Missing value for --${key}`)
            process.exit(1)
        }

        acc[key] = value
        i++
    }
    return acc
}

function parseIntegerArg(
    value: string | undefined,
    defaultValue: number,
    flagName: string,
): number {
    if (value === undefined) return defaultValue
    const parsed = parseInt(value, 10)
    if (isNaN(parsed)) {
        console.error(`Invalid value for --${flagName}: ${value}. Expected an integer.`)
        process.exit(1)
    }
    return parsed
}

const args: CliArgs = parseCliArgs(process.argv.slice(2))

const RELAY_URL: string = args.url ?? 'ws://localhost:8008'
const TOTAL_ZOMBIES: number = parseIntegerArg(args.zombies, 5000, 'zombies')
const SPAM_RATE: number = parseIntegerArg(args['spam-rate'], 0, 'spam-rate')
const BATCH_SIZE: number = 100
const BATCH_DELAY_MS: number = 50

// ── State ────────────────────────────────────────────────────────────────────

const zombies: WebSocketWithReceiver[] = []
let opened: number = 0
let errors: number = 0
let subsSent: number = 0
let spamSent: number = 0

// ── Shared Helpers ───────────────────────────────────────────────────────────

function randomHex(bytes: number = 16): string {
    return crypto.randomBytes(bytes).toString('hex')
}

async function sha256(input: string): Promise<string> {
    return crypto.createHash('sha256').update(input).digest('hex')
}

// ── Spammer Logic ────────────────────────────────────────────────────────────

async function createValidEvent(privateKeyHex: string): Promise<NostrEvent> {
    const pubkey: string = secp256k1.utils.bytesToHex(
        secp256k1.schnorr.getPublicKey(privateKeyHex),
    )
    const created_at: number = Math.floor(Date.now() / 1000)
    const kind: number = 1
    const content: string = `Load Test Event ${created_at}-${randomHex(4)}`

    const serialized: string = JSON.stringify([0, pubkey, created_at, kind, [], content])
    const id: string = await sha256(serialized)
    const sigBytes: Uint8Array = await secp256k1.schnorr.sign(id, privateKeyHex)
    const sig: string = secp256k1.utils.bytesToHex(sigBytes)

    return { id, pubkey, created_at, kind, tags: [], content, sig }
}

function startSpammer(): void {
    if (SPAM_RATE <= 0) return

    const ws = new WebSocket(RELAY_URL)
    const spammerPrivKey: string = secp256k1.utils.bytesToHex(
        secp256k1.utils.randomPrivateKey(),
    )
    const intervalMs: number = 1000 / SPAM_RATE
    let spammerInterval: ReturnType<typeof setInterval> | null = null

    function clearSpammerInterval(): void {
        if (spammerInterval !== null) {
            clearInterval(spammerInterval)
            spammerInterval = null
        }
    }

    ws.on('open', () => {
        console.log(`\n[SPAMMER] Connected. Flooding ${SPAM_RATE} events/sec...`)
        clearSpammerInterval()
        spammerInterval = setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN) return

            const event: NostrEvent = await createValidEvent(spammerPrivKey)
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['EVENT', event]))
                spamSent++
            }
        }, intervalMs)
    })

    ws.on('close', () => {
        clearSpammerInterval()
        console.log('[SPAMMER] Disconnected. Reconnecting...')
        setTimeout(startSpammer, 1000)
    })

    ws.on('error', () => {
        clearSpammerInterval()
    })
}

// ── Zombie Logic ─────────────────────────────────────────────────────────────

function openZombie(): Promise<WebSocketWithReceiver | null> {
    return new Promise((resolve) => {
        const ws = new WebSocket(RELAY_URL, {
            followRedirects: false,
            perMessageDeflate: false,
            handshakeTimeout: 30000,
        }) as WebSocketWithReceiver

        ws.on('open', () => {
            opened++
            const subscriptionId: string = randomHex(8)
            ws.send(JSON.stringify(['REQ', subscriptionId, { kinds: [1], limit: 1 }]))
            subsSent++

            // Suppress the automatic internal pong handling
            if (ws._receiver) {
                ws._receiver.removeAllListeners('ping')
                ws._receiver.on('ping', () => { })
            } else {
                console.warn('[ZOMBIES] Warning: ws._receiver not found. Pong suppression might fail.')
            }
            ws.pong = function (): void { }

            zombies.push(ws)
            if (opened % 500 === 0) logProgress()
            resolve(ws)
        })

        ws.on('error', (_err: Error) => {
            errors++
            ws.terminate()
            resolve(null)
        })

        ws.on('message', () => { }) // Discard broadcast data
    })
}

function logProgress(): void {
    const mem: NodeJS.MemoryUsage = process.memoryUsage()
    console.log(
        `[ZOMBIES] Opened: ${opened}/${TOTAL_ZOMBIES} | ` +
        `Client RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`,
    )
}

// ── Main Execution ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗')
    console.log('║               NOSTREAM SECURITY LOAD TESTER                  ║')
    console.log('╠══════════════════════════════════════════════════════════════╣')
    console.log(`║  Target:     ${RELAY_URL.padEnd(46)}║`)
    console.log(`║  Zombies:    ${String(TOTAL_ZOMBIES).padEnd(46)}║`)
    console.log(`║  Spam Rate:  ${String(SPAM_RATE).padEnd(41)}eps ║`)
    console.log('╚══════════════════════════════════════════════════════════════╝\n')

    // Launch Zombies
    for (let i = 0; i < TOTAL_ZOMBIES; i += BATCH_SIZE) {
        const batch: number = Math.min(BATCH_SIZE, TOTAL_ZOMBIES - i)
        const promises: Promise<WebSocketWithReceiver | null>[] = Array.from({ length: batch }).map(
            () => openZombie(),
        )
        await Promise.all(promises)
        if (i + BATCH_SIZE < TOTAL_ZOMBIES) {
            await new Promise<void>((r) => setTimeout(r, BATCH_DELAY_MS))
        }
    }

    if (TOTAL_ZOMBIES > 0) {
        console.log(`\n✅ Finished generating ${TOTAL_ZOMBIES} zombies.`)
    }

    // Launch Spammer
    if (SPAM_RATE > 0) {
        startSpammer()
    }

    // Monitor Output
    const statsInterval: ReturnType<typeof setInterval> = setInterval(() => {
        const alive: number = zombies.filter(
            (ws) => ws && ws.readyState === WebSocket.OPEN,
        ).length
        const closed: number = zombies.filter(
            (ws) => ws && ws.readyState === WebSocket.CLOSED,
        ).length

        console.log(
            `[STATS] Zombies Alive: ${alive} | Closed: ${closed} | ` +
            `Spam Sent: ${spamSent}`,
        )

        // Auto-exit if all zombies have been correctly evicted by the server
        if (TOTAL_ZOMBIES > 0 && closed > 0 && alive === 0) {
            console.log('\n✅ ALL ZOMBIES WERE EVICTED BY THE SERVER!')
            console.log('   The heartbeat memory leak fix is working correctly.')
            process.exit(0)
        }
    }, 15000)

    // Graceful Teardown
    process.on('SIGINT', () => {
        console.log('\n[SHUTDOWN] Exiting and closing connections...')
        clearInterval(statsInterval)
        for (const ws of zombies) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.close()
        }
        setTimeout(() => process.exit(0), 1000)
    })
}

main().catch((err: unknown) => {
    console.error('Fatal error:', err)
    process.exit(1)
})
