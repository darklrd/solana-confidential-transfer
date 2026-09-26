// Phase 4 specs — ApplyPendingBalance.
//
// Offline (always runs): the apply invariants over structured diffs — pending
// reset to the zero ciphertext, counter zeroed, expected/actual recorded,
// available up by exactly the pending amount — and the race-guard failure.
//
// Network (skip with SKIP_NETWORK_TESTS=1): a fresh throwaway confidential
// mint, two deposits (two credits), then apply through the shared src/apply
// module the script and the Lab both use.
import { describe, expect, it } from 'vitest';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
} from '@solana-program/token-2022';
import { getCreateConfidentialTransferAccountInstructionPlan } from '@solana-program/token-2022/confidential';
import { assertApplyTransition, prepareApplyPendingBalance } from '../src/apply';
import { getRpc, loadKeypairSigner } from '../src/config';
import { inspectTokenAccount } from '../src/inspector/decodeAccount';
import { decryptConfidentialBalances } from '../src/inspector/decrypt';
import { deriveConfidentialKeys } from '../src/keys';
import { createAccountSnapshot, type AccountSnapshot } from '../src/snapshot/capture';
import { diffAccountSnapshots } from '../src/snapshot/diff';
import { executeInstructionPlan, sendInstructions } from '../src/tx';

const ZERO = Buffer.alloc(64).toString('base64');
const cipher = (fill: number, length = 64) => Buffer.alloc(length, fill).toString('base64');

type Confidential = NonNullable<AccountSnapshot['confidential']>;

function snapshot(label: string, confidential: Partial<Confidential>, publicBalanceRaw = '0'): AccountSnapshot {
  return {
    label,
    timestamp: '2026-09-26T00:00:00.000Z',
    account: 'Account111111111111111111111111111111111111',
    mint: 'Mint111111111111111111111111111111111111111',
    decimals: 2,
    symbol: 'TEST',
    publicBalanceRaw,
    extensions: ['ConfidentialTransferAccount'],
    confidential: {
      approved: true,
      elgamalPubkey: 'ElGamal11111111111111111111111111111111111',
      pendingBalanceLowCiphertext: ZERO,
      pendingBalanceHighCiphertext: ZERO,
      availableBalanceCiphertext: ZERO,
      decryptableAvailableBalanceCiphertext: cipher(0, 36),
      pendingCreditCounter: '0',
      maximumPendingCreditCounter: '65536',
      expectedPendingCreditCounter: '0',
      actualPendingCreditCounter: '0',
      ...confidential,
    },
  };
}

// Two credits (100 + 50 raw) pending, 25 already available, then a clean apply.
const before = snapshot('before', {
  pendingBalanceLowCiphertext: cipher(1),
  availableBalanceCiphertext: cipher(2),
  decryptableAvailableBalanceCiphertext: cipher(3, 36),
  pendingCreditCounter: '2',
  expectedPendingCreditCounter: '1',
  actualPendingCreditCounter: '1',
  decrypted: { by: 'owner', pendingRaw: '150', availableRaw: '25' },
});
const after = snapshot('after', {
  availableBalanceCiphertext: cipher(4),
  decryptableAvailableBalanceCiphertext: cipher(5, 36),
  pendingCreditCounter: '0',
  expectedPendingCreditCounter: '2',
  actualPendingCreditCounter: '2',
  decrypted: { by: 'owner', pendingRaw: '0', availableRaw: '175' },
});

function withAfter(overrides: Partial<Confidential>, publicBalanceRaw?: string): AccountSnapshot {
  const base = after.confidential!;
  return {
    ...after,
    publicBalanceRaw: publicBalanceRaw ?? after.publicBalanceRaw,
    confidential: { ...base, ...overrides },
  };
}

describe('apply transition invariants (offline)', () => {
  it('accepts pending folded into available with the race guard satisfied', () => {
    const diff = diffAccountSnapshots(before, after);
    expect(() => assertApplyTransition(diff, 2n)).not.toThrow();
    expect(diff.confidential).toMatchObject({
      pendingBalanceLow: { changed: true, cleared: true, appeared: false },
      // A limb that was never credited stays the zero ciphertext: unchanged, not cleared.
      pendingBalanceHigh: { changed: false, cleared: false },
      availableBalance: { changed: true, cleared: false },
      pendingCreditCounter: { delta: '-2', direction: 'down' },
      decrypted: { pending: { delta: '-150' }, available: { delta: '150' } },
    });
  });

  it('rejects a credit that landed after the instruction was built', () => {
    const raced = withAfter({ actualPendingCreditCounter: '3' });
    expect(() => assertApplyTransition(diffAccountSnapshots(before, raced), 2n)).toThrow(
      'A credit landed while applying',
    );
  });

  it('rejects an expected counter other than the one the instruction stated', () => {
    expect(() => assertApplyTransition(diffAccountSnapshots(before, after), 1n)).toThrow(
      'expected credit counter',
    );
  });

  it('rejects leftover pending ciphertext or credits', () => {
    expect(() =>
      assertApplyTransition(
        diffAccountSnapshots(before, withAfter({ pendingBalanceHighCiphertext: cipher(6) })),
        2n,
      ),
    ).toThrow('zero ciphertext');
    expect(() =>
      assertApplyTransition(diffAccountSnapshots(before, withAfter({ pendingCreditCounter: '1' })), 2n),
    ).toThrow('reset the pending credit counter');
  });

  it('rejects an available balance that moved by anything but the pending amount', () => {
    const short = withAfter({ decrypted: { by: 'owner', pendingRaw: '0', availableRaw: '170' } });
    expect(() => assertApplyTransition(diffAccountSnapshots(before, short), 2n)).toThrow(
      'exactly the applied pending amount',
    );
  });

  it('rejects any public balance movement', () => {
    const leaked = withAfter({}, '1');
    expect(() => assertApplyTransition(diffAccountSnapshots(before, leaked), 2n)).toThrow(
      'public balance',
    );
  });

  it('requires the owner-decrypted view on both sides', () => {
    const { decrypted: _before, ...publicBefore } = before.confidential!;
    const observerOnly = { ...before, confidential: publicBefore };
    expect(() => assertApplyTransition(diffAccountSnapshots(observerOnly, after), 2n)).toThrow(
      'owner-decrypted',
    );
  });
});

describe.skipIf(process.env.SKIP_NETWORK_TESTS === '1')('confidential apply on chain', () => {
  it('folds two pending credits into available and records the race guard', async () => {
    const rpc = getRpc();
    const payer: KeyPairSigner = await loadKeypairSigner();
    const mint = await generateKeyPairSigner();
    const decimals = 2;
    const first = 70_000n; // low=4464, high=1: both pending limbs get credited
    const second = 250n;
    const confidentialExt = {
      __kind: 'ConfidentialTransferMint',
      authority: payer.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    } as const;
    const space = BigInt(getMintSize([confidentialExt]));
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();

    await sendInstructions(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.address,
        authority: payer.address,
        autoApproveNewAccounts: true,
        auditorElgamalPubkey: null,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
    ]);

    const keys = await deriveConfidentialKeys(payer, mint.address);
    const plan = await getCreateConfidentialTransferAccountInstructionPlan({
      payer,
      owner: payer,
      mint: mint.address,
      rpc,
      elgamalKeypair: keys.elgamalKeypair,
      aesKey: keys.aeKey,
    });
    await executeInstructionPlan(payer, plan);
    const [token] = await findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mint.address,
    });

    await expect(prepareApplyPendingBalance(token, payer, keys)).rejects.toThrow('Nothing pending');

    await sendInstructions(payer, [
      getMintToCheckedInstruction({
        mint: mint.address,
        token,
        mintAuthority: payer,
        amount: first + second,
        decimals,
      }),
    ]);
    for (const amount of [first, second]) {
      await sendInstructions(payer, [
        getConfidentialDepositInstruction({
          token,
          mint: mint.address,
          authority: payer,
          amount,
          decimals,
        }),
      ]);
    }

    const beforeInspection = await inspectTokenAccount(token);
    const before = createAccountSnapshot('before apply', beforeInspection, {
      by: 'owner',
      ...decryptConfidentialBalances(beforeInspection, keys),
    });
    expect(before.confidential?.decrypted).toEqual({
      by: 'owner',
      pendingRaw: (first + second).toString(),
      availableRaw: '0',
    });

    const { instruction, expectedCreditCounter } = await prepareApplyPendingBalance(token, payer, keys);
    expect(expectedCreditCounter).toBe(2n);
    await sendInstructions(payer, [instruction]);

    const afterInspection = await inspectTokenAccount(token);
    const after = createAccountSnapshot('after apply', afterInspection, {
      by: 'owner',
      ...decryptConfidentialBalances(afterInspection, keys),
    });
    const diff = diffAccountSnapshots(before, after);

    expect(() => assertApplyTransition(diff, expectedCreditCounter)).not.toThrow();
    expect(after.confidential?.decrypted).toEqual({
      by: 'owner',
      pendingRaw: '0',
      availableRaw: (first + second).toString(),
    });
    expect(diff.confidential).toMatchObject({
      pendingBalanceLow: { cleared: true },
      pendingBalanceHigh: { cleared: true },
      availableBalance: { appeared: true },
      pendingCreditCounter: { before: '2', after: '0' },
      expectedPendingCreditCounter: { after: '2' },
      actualPendingCreditCounter: { after: '2' },
    });

    await expect(prepareApplyPendingBalance(token, payer, keys)).rejects.toThrow('Nothing pending');
  });
});
