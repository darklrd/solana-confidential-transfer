// apply.ts — ApplyPendingBalance (Phase 4), shared by script 12 and the Lab.
//
// Incoming credits land in the pending balance; apply folds pending into
// available at a moment the owner chooses. It needs no ZK proof: the owner
// decrypts pending in memory and supplies the new AES-encrypted available
// balance, and the program folds the ElGamal ciphertexts homomorphically.
//
// The instruction states the pending credit counter it saw (the race guard).
// On-chain, apply records that as `expected` and the counter it actually
// folded as `actual`. If a credit lands between reading the account and
// executing, actual > expected: the ElGamal available includes the late
// credit, but the AES copy the owner computed does not.
import { fetchToken } from '@solana-program/token-2022';
import { getApplyConfidentialPendingBalanceInstructionFromToken } from '@solana-program/token-2022/confidential';
import type { Address, Instruction, TransactionSigner } from '@solana/kit';
import { getRpc } from './config';
import type { ConfidentialKeys } from './keys';
import { isZeroCiphertext, type AccountSnapshotDiff } from './snapshot/diff';

/** The account is in a state apply cannot (or need not) act on. */
export class ApplyPreconditionError extends Error {}

export type PreparedApply = {
  instruction: Instruction;
  /** The pending credit counter the instruction claims to have seen. */
  expectedCreditCounter: bigint;
};

/**
 * Fetch the token account and build ApplyPendingBalance from that exact
 * state. The ElGamal secret key is materialized only for the build.
 */
export async function prepareApplyPendingBalance(
  token: Address,
  authority: TransactionSigner,
  keys: ConfidentialKeys,
): Promise<PreparedApply> {
  const fetched = await fetchToken(getRpc(), token);
  const extensions = fetched.data.extensions.__option === 'Some' ? fetched.data.extensions.value : [];
  const confidential = extensions.find((e) => e.__kind === 'ConfidentialTransferAccount');
  if (!confidential || confidential.__kind !== 'ConfidentialTransferAccount') {
    throw new ApplyPreconditionError('Account is not configured for confidential transfers.');
  }
  if (confidential.pendingBalanceCreditCounter === 0n) {
    throw new ApplyPreconditionError('Nothing pending to apply — run a deposit first.');
  }

  const elgamalSecretKey = keys.elgamalKeypair.secret();
  try {
    const instruction = getApplyConfidentialPendingBalanceInstructionFromToken({
      token,
      tokenAccount: fetched.data,
      authority,
      elgamalSecretKey,
      aesKey: keys.aeKey,
    });
    return { instruction, expectedCreditCounter: confidential.pendingBalanceCreditCounter };
  } finally {
    elgamalSecretKey.free();
  }
}

/**
 * Check a before/after diff (owner-decrypted on both sides) against what
 * ApplyPendingBalance must do. Throws on the first violated invariant.
 * Assumes `before` saw the same credits the instruction was built from.
 */
export function assertApplyTransition(
  diff: AccountSnapshotDiff,
  expectedCreditCounter: bigint,
): void {
  const c = diff.confidential;
  if (!c) throw new Error('Apply diff is missing confidential state.');
  if (!c.decrypted || c.decrypted.by !== 'owner') {
    throw new Error('Apply diff needs owner-decrypted balances on both sides.');
  }
  if (diff.publicBalance.direction !== 'unchanged') {
    throw new Error('Apply changed the public balance; it must only move pending into available.');
  }
  if (c.expectedPendingCreditCounter.after !== expectedCreditCounter.toString()) {
    throw new Error('Apply did not record the expected credit counter the instruction stated.');
  }
  if (c.actualPendingCreditCounter.after !== expectedCreditCounter.toString()) {
    throw new Error(
      `A credit landed while applying: the instruction saw ${expectedCreditCounter} credits but ` +
        `${c.actualPendingCreditCounter.after} were folded. The AES available balance is stale until the next apply.`,
    );
  }
  if (c.pendingCreditCounter.after !== '0') {
    throw new Error('Apply did not reset the pending credit counter to zero.');
  }
  if (c.maximumPendingCreditCounter.direction !== 'unchanged') {
    throw new Error('Apply changed the maximum pending credit counter.');
  }
  if (!isZeroCiphertext(c.pendingBalanceLow.after) || !isZeroCiphertext(c.pendingBalanceHigh.after)) {
    throw new Error('Apply did not reset the pending ciphertexts to the zero ciphertext.');
  }
  if (!c.decryptableAvailableBalance.changed) {
    throw new Error('Apply did not write a new decryptable available balance.');
  }
  if (c.decrypted.pending.after !== '0') {
    throw new Error('Owner still decrypts a non-zero pending balance after apply.');
  }
  if (c.decrypted.available.delta !== c.decrypted.pending.before) {
    throw new Error('Available balance did not increase by exactly the applied pending amount.');
  }
}
