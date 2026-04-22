import { verifyEventSignature } from './task4';
import * as secp256k1 from '@noble/secp256k1';
import * as crypto from 'crypto';

async function testTask4() {
  const privKey = '0000000000000000000000000000000000000000000000000000000000000001';
  const pubKey = secp256k1.utils.bytesToHex(secp256k1.getPublicKey(privKey, true).subarray(1));
  
  const event: any = {
    pubkey: pubKey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 1,
    tags: [],
    content: 'Test content',
  };

  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content
  ]);
  event.id = crypto.createHash('sha256').update(serialized).digest('hex');
  
  const sig = await secp256k1.schnorr.sign(event.id, privKey);
  event.sig = secp256k1.utils.bytesToHex(sig);

  const isValid = await verifyEventSignature(event);
  console.log('Is generated event signature valid?', isValid);
}

testTask4().catch(console.error);
