// Structured before/after comparison for public and confidential account state.
import { formatAmount } from '../inspector/decodeAccount';
import type { AccountSnapshot } from './capture';

export type NumericChange = {
  before: string;
  after: string;
  delta: string;
  direction: 'up' | 'down' | 'unchanged';
};

export type CiphertextChange = {
  before: string;
  after: string;
  changed: boolean;
  /** Was the all-zero placeholder, now real ciphertext (e.g. first deposit). */
  appeared: boolean;
  /** Was real ciphertext, now the all-zero placeholder (e.g. apply resets pending). */
  cleared: boolean;
};

export type AccountSnapshotDiff = {
  account: string;
  mint: string;
  publicBalance: NumericChange;
  confidential?: {
    pendingBalanceLow: CiphertextChange;
    pendingBalanceHigh: CiphertextChange;
    availableBalance: CiphertextChange;
    decryptableAvailableBalance: CiphertextChange;
    pendingCreditCounter: NumericChange;
    maximumPendingCreditCounter: NumericChange;
    expectedPendingCreditCounter: NumericChange;
    actualPendingCreditCounter: NumericChange;
    decrypted?: {
      by: 'owner' | 'auditor';
      pending: NumericChange;
      available: NumericChange;
    };
  };
};

function numericChange(before: string, after: string): NumericChange {
  const delta = BigInt(after) - BigInt(before);
  return {
    before,
    after,
    delta: delta.toString(),
    direction: delta > 0n ? 'up' : delta < 0n ? 'down' : 'unchanged',
  };
}

/** The all-zero bytes Token-2022 uses for an untouched or reset balance. */
export function isZeroCiphertext(value: string): boolean {
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.every((byte) => byte === 0);
}

function ciphertextChange(before: string, after: string): CiphertextChange {
  const changed = before !== after;
  return {
    before,
    after,
    changed,
    appeared: changed && isZeroCiphertext(before) && !isZeroCiphertext(after),
    cleared: changed && !isZeroCiphertext(before) && isZeroCiphertext(after),
  };
}

/** Compare snapshots of the same account. Cross-account diffs are rejected. */
export function diffAccountSnapshots(
  before: AccountSnapshot,
  after: AccountSnapshot,
): AccountSnapshotDiff {
  if (before.account !== after.account || before.mint !== after.mint) {
    throw new Error('Cannot diff snapshots from different token accounts or mints.');
  }
  if (before.decimals !== after.decimals) {
    throw new Error('Cannot diff snapshots with different mint decimals.');
  }
  if (!!before.confidential !== !!after.confidential) {
    throw new Error('Confidential account extension presence changed between snapshots.');
  }

  const confidential =
    before.confidential && after.confidential
      ? {
          pendingBalanceLow: ciphertextChange(
            before.confidential.pendingBalanceLowCiphertext,
            after.confidential.pendingBalanceLowCiphertext,
          ),
          pendingBalanceHigh: ciphertextChange(
            before.confidential.pendingBalanceHighCiphertext,
            after.confidential.pendingBalanceHighCiphertext,
          ),
          availableBalance: ciphertextChange(
            before.confidential.availableBalanceCiphertext,
            after.confidential.availableBalanceCiphertext,
          ),
          decryptableAvailableBalance: ciphertextChange(
            before.confidential.decryptableAvailableBalanceCiphertext,
            after.confidential.decryptableAvailableBalanceCiphertext,
          ),
          pendingCreditCounter: numericChange(
            before.confidential.pendingCreditCounter,
            after.confidential.pendingCreditCounter,
          ),
          maximumPendingCreditCounter: numericChange(
            before.confidential.maximumPendingCreditCounter,
            after.confidential.maximumPendingCreditCounter,
          ),
          expectedPendingCreditCounter: numericChange(
            before.confidential.expectedPendingCreditCounter,
            after.confidential.expectedPendingCreditCounter,
          ),
          actualPendingCreditCounter: numericChange(
            before.confidential.actualPendingCreditCounter,
            after.confidential.actualPendingCreditCounter,
          ),
          decrypted:
            before.confidential.decrypted &&
            after.confidential.decrypted &&
            before.confidential.decrypted.by === after.confidential.decrypted.by
              ? {
                  by: before.confidential.decrypted.by,
                  pending: numericChange(
                    before.confidential.decrypted.pendingRaw,
                    after.confidential.decrypted.pendingRaw,
                  ),
                  available: numericChange(
                    before.confidential.decrypted.availableRaw,
                    after.confidential.decrypted.availableRaw,
                  ),
                }
              : undefined,
        }
      : undefined;

  return {
    account: before.account,
    mint: before.mint,
    publicBalance: numericChange(before.publicBalanceRaw, after.publicBalanceRaw),
    confidential,
  };
}

function formatDelta(change: NumericChange, decimals: number): string {
  const delta = BigInt(change.delta);
  const sign = delta > 0n ? '+' : delta < 0n ? '-' : '';
  const magnitude = delta < 0n ? -delta : delta;
  return `${formatAmount(BigInt(change.before), decimals)} → ${formatAmount(BigInt(change.after), decimals)} (Δ ${sign}${formatAmount(magnitude, decimals)})`;
}

/** Human-readable rendering; the structured diff remains the stable contract. */
export function renderAccountSnapshotDiff(
  before: AccountSnapshot,
  after: AccountSnapshot,
  diff: AccountSnapshotDiff = diffAccountSnapshots(before, after),
): void {
  const symbol = after.symbol ?? 'tokens';
  console.log(`\n┌─ ${before.label} → ${after.label}`);
  console.log(`│  public balance : ${formatDelta(diff.publicBalance, after.decimals)} ${symbol}`);

  if (diff.confidential) {
    const pendingChanged =
      diff.confidential.pendingBalanceLow.changed || diff.confidential.pendingBalanceHigh.changed;
    const pendingAppeared =
      diff.confidential.pendingBalanceLow.appeared || diff.confidential.pendingBalanceHigh.appeared;
    const pendingCleared =
      diff.confidential.pendingBalanceLow.cleared || diff.confidential.pendingBalanceHigh.cleared;
    console.log(
      `│  pending cipher : ${pendingAppeared ? 'appeared' : pendingCleared ? 'cleared' : pendingChanged ? 'changed' : 'unchanged'} (amount hidden from observer)`,
    );
    console.log(
      `│  available cipher: ${diff.confidential.availableBalance.changed ? 'changed' : 'unchanged'}`,
    );
    console.log(
      `│  pending credits: ${diff.confidential.pendingCreditCounter.before} → ${diff.confidential.pendingCreditCounter.after} (Δ ${diff.confidential.pendingCreditCounter.delta})`,
    );
    // Only apply resets the pending counter; the same expected/actual as the
    // previous apply is still worth showing, so key off the reset.
    const { expectedPendingCreditCounter: expected, actualPendingCreditCounter: actual } =
      diff.confidential;
    if (
      diff.confidential.pendingCreditCounter.direction === 'down' ||
      expected.direction !== 'unchanged' ||
      actual.direction !== 'unchanged'
    ) {
      console.log(`│  apply counters : expected ${expected.after}, actual ${actual.after} (race guard)`);
    }
    if (diff.confidential.decrypted) {
      console.log(
        `│  ${diff.confidential.decrypted.by} pending : ${formatDelta(diff.confidential.decrypted.pending, after.decimals)} ${symbol}`,
      );
      console.log(
        `│  ${diff.confidential.decrypted.by} available: ${formatDelta(diff.confidential.decrypted.available, after.decimals)} ${symbol}`,
      );
    }
  }
  console.log('└─');
}
