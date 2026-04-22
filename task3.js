const WebSocket = require('ws');
const secp256k1 = require('@noble/secp256k1');
const crypto = require('crypto');

/**
 * Task 3: Standalone Node.js script that connects to a relay,
 * receives an AUTH challenge, constructs a valid kind 22242 event,
 * and sends it back.
 */
async function solveTask3() {
    const relayUrl = 'ws://localhost:8008';
    const ws = new WebSocket(relayUrl);

    // Generate a temporary keypair for the demo
    const privKey = secp256k1.utils.randomPrivateKey();
    const pubKey = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(privKey, true).subarray(1));

    console.log('Connecting to', relayUrl, '...');

    ws.on('open', () => {
        console.log('Connected to relay');
    });

    ws.on('message', async (data) => {
        const message = JSON.parse(data.toString());
        console.log('Received from relay:', message);

        if (message[0] === 'AUTH' && typeof message[1] === 'string') {
            const challenge = message[1];
            console.log('>>> Received AUTH challenge:', challenge);

            // Construct kind 22242 event (NIP-42)
            const event = {
                pubkey: pubKey,
                created_at: Math.floor(Date.now() / 1000),
                kind: 22242,
                tags: [
                    ['relay', relayUrl],
                    ['challenge', challenge]
                ],
                content: ''
            };

            // Calculate ID (Hash)
            const serialized = JSON.stringify([
                0,
                event.pubkey,
                event.created_at,
                event.kind,
                event.tags,
                event.content
            ]);
            const id = crypto.createHash('sha256').update(serialized).digest('hex');
            event.id = id;

            // Sign event
            console.log('Signing event...');
            const sig = await secp256k1.schnorr.sign(event.id, privKey);
            event.sig = secp256k1.utils.bytesToHex(sig);

            // Send back
            const authResponse = JSON.stringify(['AUTH', event]);
            console.log('>>> Sending AUTH response:', authResponse);
            ws.send(authResponse);
            
            // Wait a bit to see if we get a response (though NIP-42 doesn't mandate one)
            setTimeout(() => {
                console.log('Closing connection...');
                ws.close();
            }, 2000);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    ws.on('close', () => {
        console.log('Connection closed');
    });
}

solveTask3().catch(console.error);
