#!/usr/bin/env node
/**
 * security-load-test.js
 * 
 * A generalized load testing and security emulation tool for Nostream.
 * Simulates a combined Slowloris (Zombie) attack and an Event Flood attack.
 * 
 * Features:
 * 1. Zombie Connections: Opens connections, subscribes, and silences pongs.
 * 2. Active Spammer: Generates and publishes valid NOSTR events (signed via secp256k1).
 * 
 * Usage:
 *   node scripts/security-load-test.js [--url ws://localhost:8008] [--zombies 5000] [--spam-rate 100]
 * 
 * Alternate (via npm):
 *   npm run test:load -- --zombies 5000
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const secp256k1 = require('@noble/secp256k1');

// ── CLI Args ─────────────────────────────────────────────────────────────────
function parseCliArgs(argv) {
    const acc = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;

        const key = arg.slice(2);
        const value = argv[i + 1];

        if (value === undefined || value.startsWith('--')) {
            console.error(`Missing value for --${key}`);
            process.exit(1);
        }

        acc[key] = value;
        i++;
    }
    return acc;
}

function parseIntegerArg(value, defaultValue, flagName) {
    if (value === undefined) return defaultValue;
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
        console.error(`Invalid value for --${flagName}: ${value}. Expected an integer.`);
        process.exit(1);
    }
    return parsed;
}

const args = parseCliArgs(process.argv.slice(2));

const RELAY_URL = args.url || 'ws://localhost:8008';
const TOTAL_ZOMBIES = parseIntegerArg(args.zombies, 5000, 'zombies');
const SPAM_RATE = parseIntegerArg(args['spam-rate'], 0, 'spam-rate');
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 50;

// ── State ────────────────────────────────────────────────────────────────────
const zombies = [];
let opened = 0;
let errors = 0;
let subsSent = 0;
let spamSent = 0;

// ── Shared Helpers ───────────────────────────────────────────────────────────
function randomHex(bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
}

async function sha256(string) {
    const hash = crypto.createHash('sha256').update(string).digest('hex');
    return hash;
}

// ── Spammer Logic ────────────────────────────────────────────────────────────
async function createValidEvent(privateKeyHex) {
    const pubkey = secp256k1.utils.bytesToHex(secp256k1.schnorr.getPublicKey(privateKeyHex));
    const created_at = Math.floor(Date.now() / 1000);
    const kind = 1;
    const content = `Load Test Event ${created_at}-${randomHex(4)}`;

    const serialized = JSON.stringify([0, pubkey, created_at, kind, [], content]);
    const id = await sha256(serialized);
    const sigBytes = await secp256k1.schnorr.sign(id, privateKeyHex);
    const sig = secp256k1.utils.bytesToHex(sigBytes);

    return { id, pubkey, created_at, kind, tags: [], content, sig };
}

function startSpammer() {
    if (SPAM_RATE <= 0) return;

    const ws = new WebSocket(RELAY_URL);
    const spammerPrivKey = secp256k1.utils.bytesToHex(secp256k1.utils.randomPrivateKey());
    const intervalMs = 1000 / SPAM_RATE;
    let spammerInterval = null;

    function clearSpammerInterval() {
        if (spammerInterval !== null) {
            clearInterval(spammerInterval);
            spammerInterval = null;
        }
    }

    ws.on('open', () => {
        console.log(`\n[SPAMMER] Connected. Flooding ${SPAM_RATE} events/sec...`);
        clearSpammerInterval();
        spammerInterval = setInterval(async () => {
            if (ws.readyState !== WebSocket.OPEN) return;

            const event = await createValidEvent(spammerPrivKey);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(['EVENT', event]));
                spamSent++;
            }
        }, intervalMs);
    });

    ws.on('close', () => {
        clearSpammerInterval();
        console.log('[SPAMMER] Disconnected. Reconnecting...');
        setTimeout(startSpammer, 1000);
    });

    ws.on('error', () => {
        clearSpammerInterval();
    });
}

// ── Zombie Logic ─────────────────────────────────────────────────────────────
function openZombie() {
    return new Promise((resolve) => {
        const ws = new WebSocket(RELAY_URL, {
            followRedirects: false,
            perMessageDeflate: false,
            handshakeTimeout: 30000,
        });

        ws.on('open', () => {
            opened++;
            const subscriptionId = randomHex(8);
            ws.send(JSON.stringify(['REQ', subscriptionId, { kinds: [1], limit: 1 }]));
            subsSent++;

            // Suppress the automatic internal pong handling
            if (ws._receiver) {
                ws._receiver.removeAllListeners('ping');
                ws._receiver.on('ping', () => { });
            } else {
                console.warn('[ZOMBIES] Warning: ws._receiver not found. Pong suppression might fail.');
            }
            ws.pong = function () { };

            zombies.push(ws);
            if (opened % 500 === 0) logProgress();
            resolve(ws);
        });

        ws.on('error', (err) => {
            errors++;
            ws.terminate();
            resolve(null);
        });

        ws.on('message', () => { }); // Discard broadcast data
    });
}

function logProgress() {
    const mem = process.memoryUsage();
    console.log(
        `[ZOMBIES] Opened: ${opened}/${TOTAL_ZOMBIES} | ` +
        `Client RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`
    );
}

// ── Main Execution ───────────────────────────────────────────────────────────
async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║               NOSTREAM SECURITY LOAD TESTER                  ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║  Target:     ${RELAY_URL.padEnd(46)}║`);
    console.log(`║  Zombies:    ${String(TOTAL_ZOMBIES).padEnd(46)}║`);
    console.log(`║  Spam Rate:  ${String(SPAM_RATE).padEnd(41)}eps ║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Launch Zombies
    for (let i = 0; i < TOTAL_ZOMBIES; i += BATCH_SIZE) {
        const batch = Math.min(BATCH_SIZE, TOTAL_ZOMBIES - i);
        const promises = Array.from({ length: batch }).map(() => openZombie());
        await Promise.all(promises);
        if (i + BATCH_SIZE < TOTAL_ZOMBIES) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    if (TOTAL_ZOMBIES > 0) {
        console.log(`\n✅ Finished generating ${TOTAL_ZOMBIES} zombies.`);
    }

    // Launch Spammer
    if (SPAM_RATE > 0) {
        startSpammer();
    }

    // Monitor Output
    const statsInterval = setInterval(() => {
        const alive = zombies.filter(ws => ws && ws.readyState === WebSocket.OPEN).length;
        const closed = zombies.filter(ws => ws && ws.readyState === WebSocket.CLOSED).length;

        console.log(
            `[STATS] Zombies Alive: ${alive} | Closed: ${closed} | ` +
            `Spam Sent: ${spamSent}`
        );

        // Auto-exit if all zombies have been correctly evicted by the server
        if (TOTAL_ZOMBIES > 0 && closed > 0 && alive === 0) {
            console.log('\n✅ ALL ZOMBIES WERE EVICTED BY THE SERVER!');
            console.log('   The heartbeat memory leak fix is working correctly.');
            process.exit(0);
        }
    }, 15000);

    // Graceful Teardown
    process.on('SIGINT', () => {
        console.log('\n[SHUTDOWN] Exiting and closing connections...');
        clearInterval(statsInterval);
        for (const ws of zombies) {
            if (ws && ws.readyState === WebSocket.OPEN) ws.close();
        }
        setTimeout(() => process.exit(0), 1000);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
