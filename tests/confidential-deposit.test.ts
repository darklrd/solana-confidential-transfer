// Phase 3 behavior: owner decryption, snapshot/diff invariants, and live deposit.
import { describe, expect, it } from 'vitest';
import {
  generateKeyPairSigner,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  findAssociatedTokenPda,
  getConfidentialDepositInstruction,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToCheckedInstruction,
} from '@solana-program/token-2022';
import { getCreateConfidentialTransferAccountInstructionPlan } from '@solana-program/token-2022/confidential';
import { AeKey } from '@solana/zk-sdk/bundler';
import type { ConfidentialKeys } from '../src/keys';
import { deriveConfidentialKeys } from '../src/keys';
import type { TokenAccountInspection } from '../src/inspector/decodeAccount';
import { inspectTokenAccount } from '../src/inspector/decodeAccount';
import { decryptConfidentialBalances } from '../src/inspector/decrypt';
import {
  accountSnapshotSchema,
  createAccountSnapshot,
  savePublicAccountSnapshot,
} from '../src/snapshot/capture';
import { diffAccountSnapshots } from '../src/snapshot/diff';
import { getRpc, loadKeypairSigner } from '../src/config';
import { executeInstructionPlan, sendInstructions } from '../src/tx';

const ZERO_ELGAMAL = Buffer.alloc(64).toString('base64');
const LOW_BITS = 16n;

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

async function encryptedInspection(
  pendingRaw: bigint,
  availableRaw: bigint,
  publicBalanceRaw: bigint = 0n,
): Promise<{ inspection: TokenAccountInspection; keys: ConfidentialKeys }> {
  const owner = await generateKeyPairSigner();
  const mint = (await generateKeyPairSigner()).address;
  const token = (await generateKeyPairSigner()).address;
  const keys = await deriveConfidentialKeys(owner, mint);
  const pubkey = keys.elgamalKeypair.pubkey();
  const low = pubkey.encryptU64(pendingRaw & ((1n << LOW_BITS) - 1n));
  const high = pubkey.encryptU64(pendingRaw >> LOW_BITS);
  // Available ElGamal is public state, but owner reading intentionally uses the
  // authenticated-encryption u64 fast path.
  const available = pubkey.encryptU64(0n);
  const decryptableAvailable = keys.aeKey.encrypt(availableRaw);

  const inspection: TokenAccountInspection = {
    address: token,
    mint,
    owner: owner.address,
    amountRaw: publicBalanceRaw,
    amountUi: publicBalanceRaw.toString(),
    state: 'Initialized',
    delegate: null,
    closeAuthority: null,
    accountExtensions: ['ConfidentialTransferAccount'],
    confidential: {
      approved: true,
      elgamalPubkey: keys.elgamalPubkey,
      pendingBalanceLow: toBase64(low.toBytes()),
      pendingBalanceHigh: toBase64(high.toBytes()),
      availableBalance: toBase64(available.toBytes()),
      decryptableAvailableBalance: toBase64(decryptableAvailable.toBytes()),
      allowConfidentialCredits: true,
      allowNonConfidentialCredits: true,
      pendingBalanceCreditCounter: pendingRaw === 0n ? 0n : 1n,
      maximumPendingBalanceCreditCounter: 65536n,
      expectedPendingBalanceCreditCounter: 0n,
      actualPendingBalanceCreditCounter: 0n,
    },
    mintInfo: {
      decimals: 0,
      supplyRaw: publicBalanceRaw,
      supplyUi: publicBalanceRaw.toString(),
      symbol: 'TEST',
      extensions: ['ConfidentialTransferMint'],
    },
  };

  pubkey.free();
  low.free();
  high.free();
  available.free();
  decryptableAvailable.free();
  return { inspection, keys };
}

describe('owner confidential-balance decryption (offline)', () => {
  it('recombines pending values across the low-16/high-32-bit boundary', async () => {
    const pendingRaw = (3n << LOW_BITS) + 42n;
    const availableRaw = (1n << 40n) + 7n;
    const { inspection, keys } = await encryptedInspection(pendingRaw, availableRaw);

    expect(decryptConfidentialBalances(inspection, keys)).toEqual({
      pendingRaw,
      availableRaw,
    });
  });

  it('rejects keys derived for another owner instead of displaying a false balance', async () => {
    const { inspection, keys } = await encryptedInspection(123n, 0n);
    const stranger = await generateKeyPairSigner();
    const wrongKeys = await deriveConfidentialKeys(stranger, inspection.mint as Address);

    expect(() => decryptConfidentialBalances(inspection, wrongKeys)).toThrow(
      'Derived ElGamal key does not match',
    );
    // The matching keys still recover the intended amount.
    expect(decryptConfidentialBalances(inspection, keys).pendingRaw).toBe(123n);
  });

  it('rejects malformed ciphertext bytes before attempting decryption', async () => {
    const { inspection, keys } = await encryptedInspection(1n, 0n);
    const malformed: TokenAccountInspection = {
      ...inspection,
      confidential: {
        ...inspection.confidential!,
        pendingBalanceLow: Buffer.alloc(63).toString('base64'),
      },
    };

    expect(() => decryptConfidentialBalances(malformed, keys)).toThrow(
      'pending low balance must decode to 64 bytes',
    );
  });

  it('rejects missing confidential state and an unauthenticated available balance', async () => {
    const { inspection, keys } = await encryptedInspection(9n, 10n);
    expect(() =>
      decryptConfidentialBalances({ ...inspection, confidential: undefined }, keys),
    ).toThrow('not configured for confidential transfers');

    const wrongAeKey = new AeKey();
    try {
      expect(() =>
        decryptConfidentialBalances(inspection, { ...keys, aeKey: wrongAeKey }),
      ).toThrow();
    } finally {
      wrongAeKey.free();
    }
  });
});

describe('account snapshots and diffs (offline)', () => {
  it('reports the complete public-to-pending transition without inferring plaintext', async () => {
    const amount = 70_000n; // exercises both pending limbs
    const { inspection: afterInspection } = await encryptedInspection(amount, 0n, 0n);
    const beforeInspection: TokenAccountInspection = {
      ...afterInspection,
      amountRaw: amount,
      amountUi: amount.toString(),
      confidential: {
        ...afterInspection.confidential!,
        pendingBalanceLow: ZERO_ELGAMAL,
        pendingBalanceHigh: ZERO_ELGAMAL,
        pendingBalanceCreditCounter: 0n,
      },
    };
    const before = createAccountSnapshot(
      'before',
      beforeInspection,
      { by: 'owner', pendingRaw: 0n, availableRaw: 0n },
      '2026-09-06T00:00:00.000Z',
    );
    const after = createAccountSnapshot(
      'after',
      afterInspection,
      { by: 'owner', pendingRaw: amount, availableRaw: 0n },
      '2026-09-06T00:00:01.000Z',
    );

    const diff = diffAccountSnapshots(before, after);
    expect(diff.publicBalance).toMatchObject({ delta: '-70000', direction: 'down' });
    expect(diff.confidential).toMatchObject({
      pendingBalanceLow: { changed: true, appeared: true },
      pendingBalanceHigh: { changed: true, appeared: true },
      availableBalance: { changed: false },
      decryptableAvailableBalance: { changed: false },
      pendingCreditCounter: { delta: '1', direction: 'up' },
      maximumPendingCreditCounter: { delta: '0', direction: 'unchanged' },
      expectedPendingCreditCounter: { delta: '0', direction: 'unchanged' },
      actualPendingCreditCounter: { delta: '0', direction: 'unchanged' },
      decrypted: {
        by: 'owner',
        pending: { delta: '70000', direction: 'up' },
        available: { delta: '0', direction: 'unchanged' },
      },
    });
  });

  it('produces validated JSON with decimal strings instead of bigint values', async () => {
    const { inspection } = await encryptedInspection(1n, 2n, 3n);
    const snapshot = createAccountSnapshot('json-safe', inspection);

    expect(accountSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot.publicBalanceRaw).toBe('3');
    expect(snapshot.confidential?.pendingCreditCounter).toBe('1');
  });

  it('rejects cross-account comparisons', async () => {
    const first = createAccountSnapshot('first', (await encryptedInspection(0n, 0n)).inspection);
    const second = createAccountSnapshot('second', (await encryptedInspection(0n, 0n)).inspection);

    expect(() => diffAccountSnapshots(first, second)).toThrow('different token accounts or mints');
  });

  it('refuses to persist decrypted plaintext or path-like snapshot names', async () => {
    const { inspection } = await encryptedInspection(4n, 5n);
    const decrypted = createAccountSnapshot('owner', inspection, {
      by: 'owner',
      pendingRaw: 4n,
      availableRaw: 5n,
    });
    const publicOnly = createAccountSnapshot('observer', inspection);

    expect(() => savePublicAccountSnapshot(decrypted, 'owner-view')).toThrow(
      'Refusing to persist',
    );
    expect(() => savePublicAccountSnapshot(publicOnly, '../escape')).toThrow(
      'Snapshot name',
    );
  });
});

describe.skipIf(process.env.SKIP_NETWORK_TESTS === '1')('confidential deposit on chain', () => {
  it('moves an exact public amount into pending while preserving supply and available', async () => {
    const rpc = getRpc();
    const payer: KeyPairSigner = await loadKeypairSigner();
    const mint = await generateKeyPairSigner();
    const decimals = 2;
    const amount = 70_000n; // low=4464, high=1: both encrypted limbs change
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
    await sendInstructions(payer, [
      getMintToCheckedInstruction({
        mint: mint.address,
        token,
        mintAuthority: payer,
        amount,
        decimals,
      }),
    ]);

    const beforeInspection = await inspectTokenAccount(token);
    const beforeBalances = decryptConfidentialBalances(beforeInspection, keys);
    const before = createAccountSnapshot('before deposit', beforeInspection, {
      by: 'owner',
      ...beforeBalances,
    });
    const supplyBefore = (await fetchMint(rpc, mint.address)).data.supply;

    await sendInstructions(payer, [
      getConfidentialDepositInstruction({
        token,
        mint: mint.address,
        authority: payer,
        amount,
        decimals,
      }),
    ]);

    const afterInspection = await inspectTokenAccount(token);
    const afterBalances = decryptConfidentialBalances(afterInspection, keys);
    const after = createAccountSnapshot('after deposit', afterInspection, {
      by: 'owner',
      ...afterBalances,
    });
    const supplyAfter = (await fetchMint(rpc, mint.address)).data.supply;
    const diff = diffAccountSnapshots(before, after);

    expect(diff.publicBalance.delta).toBe((-amount).toString());
    expect(diff.confidential?.decrypted?.pending.delta).toBe(amount.toString());
    expect(afterBalances).toEqual({ pendingRaw: amount, availableRaw: 0n });
    const totalBefore =
      beforeInspection.amountRaw + beforeBalances.pendingRaw + beforeBalances.availableRaw;
    const totalAfter =
      afterInspection.amountRaw + afterBalances.pendingRaw + afterBalances.availableRaw;
    expect(totalAfter).toBe(totalBefore);
    expect(diff.confidential?.pendingCreditCounter.delta).toBe('1');
    expect(diff.confidential?.pendingBalanceLow.changed).toBe(true);
    expect(diff.confidential?.pendingBalanceHigh.changed).toBe(true);
    expect(diff.confidential?.availableBalance.changed).toBe(false);
    expect(diff.confidential?.decryptableAvailableBalance.changed).toBe(false);
    expect(diff.confidential?.expectedPendingCreditCounter.delta).toBe('0');
    expect(diff.confidential?.actualPendingCreditCounter.delta).toBe('0');
    expect(supplyAfter).toBe(supplyBefore);
  });
});
