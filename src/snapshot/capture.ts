// Normalized, JSON-safe account snapshots shared by scripts, diffs, and the
// future visual playground. Persisted snapshots contain public chain state only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from '@solana/kit';
import { z } from 'zod';
import { CLUSTER } from '../config';
import type { ConfidentialKeys } from '../keys';
import {
  inspectTokenAccount,
  type TokenAccountInspection,
} from '../inspector/decodeAccount';
import {
  decryptConfidentialBalances,
  type DecryptedConfidentialBalances,
} from '../inspector/decrypt';

const unsignedIntegerString = z.string().regex(/^\d+$/);

export const accountSnapshotSchema = z.object({
  label: z.string().min(1),
  timestamp: z.string().datetime(),
  account: z.string().min(1),
  mint: z.string().min(1),
  decimals: z.number().int().min(0).max(255),
  symbol: z.string().optional(),
  publicBalanceRaw: unsignedIntegerString,
  extensions: z.array(z.string()),
  confidential: z
    .object({
      approved: z.boolean(),
      elgamalPubkey: z.string().min(1),
      pendingBalanceLowCiphertext: z.string().min(1),
      pendingBalanceHighCiphertext: z.string().min(1),
      availableBalanceCiphertext: z.string().min(1),
      decryptableAvailableBalanceCiphertext: z.string().min(1),
      pendingCreditCounter: unsignedIntegerString,
      maximumPendingCreditCounter: unsignedIntegerString,
      expectedPendingCreditCounter: unsignedIntegerString,
      actualPendingCreditCounter: unsignedIntegerString,
      decrypted: z
        .object({
          by: z.enum(['owner', 'auditor']),
          pendingRaw: unsignedIntegerString,
          availableRaw: unsignedIntegerString,
        })
        .optional(),
    })
    .optional(),
});

export type AccountSnapshot = z.infer<typeof accountSnapshotSchema>;

export type SnapshotDecryption = DecryptedConfidentialBalances & {
  by: 'owner' | 'auditor';
};

/** Convert an already-fetched inspection into a validated, JSON-safe snapshot. */
export function createAccountSnapshot(
  label: string,
  inspection: TokenAccountInspection,
  decrypted?: SnapshotDecryption,
  timestamp: string = new Date().toISOString(),
): AccountSnapshot {
  const confidential = inspection.confidential;
  if (decrypted && !confidential) {
    throw new Error('Cannot attach a decrypted view to a non-confidential account.');
  }

  return accountSnapshotSchema.parse({
    label,
    timestamp,
    account: inspection.address,
    mint: inspection.mint,
    decimals: inspection.mintInfo.decimals,
    symbol: inspection.mintInfo.symbol,
    publicBalanceRaw: inspection.amountRaw.toString(),
    extensions: inspection.accountExtensions,
    confidential: confidential && {
      approved: confidential.approved,
      elgamalPubkey: confidential.elgamalPubkey,
      pendingBalanceLowCiphertext: confidential.pendingBalanceLow,
      pendingBalanceHighCiphertext: confidential.pendingBalanceHigh,
      availableBalanceCiphertext: confidential.availableBalance,
      decryptableAvailableBalanceCiphertext: confidential.decryptableAvailableBalance,
      pendingCreditCounter: confidential.pendingBalanceCreditCounter.toString(),
      maximumPendingCreditCounter:
        confidential.maximumPendingBalanceCreditCounter.toString(),
      expectedPendingCreditCounter:
        confidential.expectedPendingBalanceCreditCounter.toString(),
      actualPendingCreditCounter:
        confidential.actualPendingBalanceCreditCounter.toString(),
      decrypted: decrypted && {
        by: decrypted.by,
        pendingRaw: decrypted.pendingRaw.toString(),
        availableRaw: decrypted.availableRaw.toString(),
      },
    },
  });
}

/** Fetch, inspect, optionally decrypt in memory, and normalize an account. */
export async function captureAccountSnapshot(
  label: string,
  account: Address,
  ownerKeys?: ConfidentialKeys,
): Promise<AccountSnapshot> {
  const inspection = await inspectTokenAccount(account);
  const decrypted = ownerKeys
    ? { by: 'owner' as const, ...decryptConfidentialBalances(inspection, ownerKeys) }
    : undefined;
  return createAccountSnapshot(label, inspection, decrypted);
}

/**
 * Save public observer state for later inspection. Decrypted balances are
 * intentionally refused: plaintext confidential amounts must require an
 * explicit owner/auditor view rather than silently landing on disk.
 */
export function savePublicAccountSnapshot(snapshot: AccountSnapshot, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('Snapshot name must contain only lowercase letters, digits, and hyphens.');
  }
  if (snapshot.confidential?.decrypted) {
    throw new Error('Refusing to persist a snapshot containing decrypted confidential balances.');
  }

  const directory = resolve('snapshots', CLUSTER);
  const file = resolve(directory, `${name}.json`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${JSON.stringify(accountSnapshotSchema.parse(snapshot), null, 2)}\n`);
  return file;
}
