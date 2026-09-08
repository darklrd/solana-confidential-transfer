// Owner-only decryption for a configured ConfidentialTransferAccount.
// Ciphertexts are public; the wallet-derived ElGamal/AES keys are not persisted.
import { AeCiphertext, ElGamalCiphertext } from '@solana/zk-sdk/bundler';
import type { TokenAccountInspection } from './decodeAccount';
import type { ConfidentialKeys } from '../keys';

const PENDING_BALANCE_LOW_BITS = 16n;

export type DecryptedConfidentialBalances = {
  pendingRaw: bigint;
  availableRaw: bigint;
};

function decodeCiphertext(value: string, expectedLength: number, label: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedLength) {
    throw new Error(`${label} must decode to ${expectedLength} bytes; received ${bytes.length}.`);
  }
  if (bytes.toString('base64') !== value) {
    throw new Error(`${label} must use canonical base64 encoding.`);
  }
  return new Uint8Array(bytes);
}

function parseElGamalCiphertext(value: string, label: string): ElGamalCiphertext {
  const ciphertext = ElGamalCiphertext.fromBytes(decodeCiphertext(value, 64, label));
  if (!ciphertext) throw new Error(`${label} is not a valid ElGamal ciphertext.`);
  return ciphertext;
}

function parseAeCiphertext(value: string): AeCiphertext {
  const ciphertext = AeCiphertext.fromBytes(
    decodeCiphertext(value, 36, 'decryptable available balance'),
  );
  if (!ciphertext) {
    throw new Error('Decryptable available balance is not a valid authenticated ciphertext.');
  }
  return ciphertext;
}

/**
 * Decrypt the pending and available balances for the token-account owner.
 *
 * Pending is stored as independently encrypted low-16 and high-32-bit limbs.
 * Available uses the authenticated-encryption fast path because the SDK's
 * ElGamal discrete-log decoder is bounded to u32, while available is a u64.
 */
export function decryptConfidentialBalances(
  inspection: TokenAccountInspection,
  keys: ConfidentialKeys,
): DecryptedConfidentialBalances {
  const confidential = inspection.confidential;
  if (!confidential) {
    throw new Error('Token account is not configured for confidential transfers.');
  }
  if (confidential.elgamalPubkey !== keys.elgamalPubkey) {
    throw new Error('Derived ElGamal key does not match the token account.');
  }

  const pendingLow = parseElGamalCiphertext(
    confidential.pendingBalanceLow,
    'pending low balance',
  );
  let pendingHigh: ElGamalCiphertext;
  try {
    pendingHigh = parseElGamalCiphertext(
      confidential.pendingBalanceHigh,
      'pending high balance',
    );
  } catch (error) {
    pendingLow.free();
    throw error;
  }

  let decryptableAvailable: AeCiphertext;
  try {
    decryptableAvailable = parseAeCiphertext(confidential.decryptableAvailableBalance);
  } catch (error) {
    pendingLow.free();
    pendingHigh.free();
    throw error;
  }

  const secretKey = keys.elgamalKeypair.secret();
  try {
    const pendingLowRaw = secretKey.decrypt(pendingLow);
    const pendingHighRaw = secretKey.decrypt(pendingHigh);
    const availableRaw = keys.aeKey.decrypt(decryptableAvailable);

    return {
      pendingRaw: (pendingHighRaw << PENDING_BALANCE_LOW_BITS) + pendingLowRaw,
      availableRaw,
    };
  } finally {
    secretKey.free();
    pendingLow.free();
    pendingHigh.free();
    decryptableAvailable.free();
  }
}
