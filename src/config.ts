// Central config: env loading, RPC factory, program IDs, keypair loading.
// Keep this dependency-light — every script imports it.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
} from '@solana/kit';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

export const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8899';
export const WALLET_KEYPAIR_PATH =
  process.env.WALLET_KEYPAIR_PATH ?? './keys/wallet.json';

export const PROGRAM_IDS = {
  token2022: TOKEN_2022_PROGRAM_ADDRESS,
  // On-chain ZK ElGamal Proof program — used only in Phase 5 (confidential transfer).
  zkElGamalProof: address('ZkE1Gama1Proof11111111111111111111111111111'),
} as const;

/** Create an RPC client against RPC_URL (local validator by default). */
export function getRpc() {
  return createSolanaRpc(RPC_URL);
}

/**
 * Load a Solana keypair signer from a CLI-format JSON file (64-byte array).
 * Compatible with `solana-keygen` output and the `spl-token` CLI.
 */
export async function loadKeypairSigner(path: string = WALLET_KEYPAIR_PATH) {
  const raw = await readFile(resolve(path), 'utf8');
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}
