import * as secp256k1 from '@noble/secp256k1';

/**
 * Verifies a Nostr event signature.
 * 
 * @param event The Nostr event object containing id, pubkey, and sig.
 * @returns A promise that resolves to true if the signature is valid, false otherwise.
 */
export async function verifyEventSignature(event: {
  id: string;
  pubkey: string;
  sig: string;
}): Promise<boolean> {
  try {
    return await secp256k1.schnorr.verify(event.sig, event.id, event.pubkey);
  } catch (error) {
    console.error('Signature verification failed:', error);
    return false;
  }
}

// Example usage (uncomment to test):
/*
const mockEvent = {
  id: '...', // hex string
  pubkey: '...', // hex string
  sig: '...', // hex string
};
verifyEventSignature(mockEvent).then(console.log);
*/
