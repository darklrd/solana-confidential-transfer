// keys.ts — ElGamal + AES key management for confidential accounts (Phase 2).
//
// There are deliberately NO key files. The official pattern derives both keys
// from a wallet signature over a deterministic, domain-separated message
// whose seed is concat(owner, mint):
//
//   wallet Ed25519 keypair
//     └─ signMessage(domain ‖ owner ‖ mint)   deterministic for a given wallet
//          ├─ ElGamalKeypair.fromSignature    twisted-ElGamal (32-byte pubkey
//          │                                  goes on-chain at configure)
//          └─ AeKey.fromSignature             AES-128 key for the owner-only
//                                             "decryptable available balance"
//
// So the wallet keypair IS the key storage: the same wallet always re-derives
// the same keys, and a different mint yields different keys (no key reuse
// across mints; stable across token-account close-and-reopen). Because
// derivation runs through the OWNER's signature, only the owner can produce
// these keys — never let a third party configure the account's keys.
//
// The WASM objects come from '@solana/zk-sdk/bundler' — the SAME build the
// token-2022 confidential helpers use internally. Mixing zk-sdk builds
// (node vs bundler) would hand pointers from one WASM instance to another
// and read garbage, so this module is the single place we construct them.
import {
  deriveAeKeyForOwnerMint,
  deriveElGamalKeypairForOwnerMint,
} from '@solana-program/token-2022/confidential';
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from '@solana/zk-sdk/bundler';
import type { Address, MessagePartialSigner } from '@solana/kit';

export type ConfidentialKeys = {
  /** Base58 ElGamal pubkey — exactly the bytes ConfigureAccount stores on-chain. */
  elgamalPubkey: Address;
  /** WASM handle: proof generation (Phase 5) + balance decryption (Phase 3). */
  elgamalKeypair: ElGamalKeypair;
  /** WASM handle: AES key for the decryptable available balance. */
  aeKey: AeKey;
};

/**
 * Derive the confidential-transfer keys for `(signer, mint)`. Deterministic:
 * call it whenever the keys are needed instead of persisting them anywhere.
 */
export async function deriveConfidentialKeys(
  signer: MessagePartialSigner,
  mint: Address,
): Promise<ConfidentialKeys> {
  const owner = signer.address;
  const { elgamalPubkey, secretKey } = await deriveElGamalKeypairForOwnerMint({
    signer,
    owner,
    mint,
  });
  const aeKeyBytes = await deriveAeKeyForOwnerMint({ signer, owner, mint });

  return {
    elgamalPubkey,
    elgamalKeypair: ElGamalKeypair.fromSecretKey(
      ElGamalSecretKey.fromBytes(new Uint8Array(secretKey)),
    ),
    aeKey: AeKey.fromBytes(new Uint8Array(aeKeyBytes)),
  };
}
