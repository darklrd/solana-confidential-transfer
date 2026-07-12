// Phase 1 integration spec — confidential-capable mint against a live cluster
// (devnet by default). Creates three fresh throwaway mints in ONE transaction
// — auto-approve, manual-approve, and a plain public control — so all cases
// are asserted with a single confirmation round-trip. Skip with
// SKIP_NETWORK_TESTS=1.
//
// Asserted properties (TDD §5 Phase 1 DoD):
//   - the ConfidentialTransferMint extension is present
//   - autoApproveNewAccounts reads back correctly for BOTH policies
//   - authority round-trips; auditor is None when unset
//   - the inspector surfaces the same config, and no config on a public mint
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
} from '@solana-program/token-2022';
import { getRpc, loadKeypairSigner } from '../src/config';
import { sendInstructions } from '../src/tx';
import { inspectMint } from '../src/inspector/decodeMint';

const DECIMALS = 9;

const rpc = getRpc();
let payer: KeyPairSigner;
let autoMint: KeyPairSigner;
let manualMint: KeyPairSigner;
let publicMint: KeyPairSigner;

describe.skipIf(process.env.SKIP_NETWORK_TESTS === '1')('confidential-capable mint', () => {
  beforeAll(async () => {
    payer = await loadKeypairSigner();
    const { value: balance } = await rpc.getBalance(payer.address).send();
    expect(balance, 'payer must hold SOL — fund the wallet first').toBeGreaterThan(0n);

    autoMint = await generateKeyPairSigner();
    manualMint = await generateKeyPairSigner();
    publicMint = await generateKeyPairSigner();

    const confidentialExt = {
      __kind: 'ConfidentialTransferMint',
      authority: payer.address,
      autoApproveNewAccounts: true, // size-irrelevant: the TLV entry is fixed-size
      auditorElgamalPubkey: null,
    } as const;
    const space = BigInt(getMintSize([confidentialExt]));
    const rent = await rpc.getMinimumBalanceForRentExemption(space).send();

    const mintInstructions = (mint: KeyPairSigner, autoApprove: boolean) => [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      // Must precede initializeMint2 — extensions are fixed at creation.
      getInitializeConfidentialTransferMintInstruction({
        mint: mint.address,
        authority: payer.address,
        autoApproveNewAccounts: autoApprove,
        auditorElgamalPubkey: null,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
    ];

    const publicSpace = BigInt(getMintSize());
    const publicRent = await rpc.getMinimumBalanceForRentExemption(publicSpace).send();

    await sendInstructions(payer, [
      ...mintInstructions(autoMint, true),
      ...mintInstructions(manualMint, false),
      getCreateAccountInstruction({
        payer,
        newAccount: publicMint,
        lamports: publicRent,
        space: publicSpace,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({
        mint: publicMint.address,
        decimals: DECIMALS,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
    ]);
  });

  it('carries the ConfidentialTransferMint extension with the configured policy', async () => {
    const onchain = await fetchMint(rpc, autoMint.address);
    expect(onchain.data.isInitialized).toBe(true);

    const exts = onchain.data.extensions.__option === 'Some' ? onchain.data.extensions.value : [];
    const ct = exts.find((e) => e.__kind === 'ConfidentialTransferMint');
    expect(ct, 'extension must be present').toBeDefined();
    if (!ct || ct.__kind !== 'ConfidentialTransferMint') throw new Error('unreachable');

    expect(ct.autoApproveNewAccounts).toBe(true);
    expect(ct.authority).toEqual({ __option: 'Some', value: payer.address });
    expect(ct.auditorElgamalPubkey).toEqual({ __option: 'None' });
  });

  it('reads autoApproveNewAccounts = false on the manual-approve mint', async () => {
    const onchain = await fetchMint(rpc, manualMint.address);
    const exts = onchain.data.extensions.__option === 'Some' ? onchain.data.extensions.value : [];
    const ct = exts.find((e) => e.__kind === 'ConfidentialTransferMint');
    if (!ct || ct.__kind !== 'ConfidentialTransferMint') throw new Error('extension missing');

    expect(ct.autoApproveNewAccounts).toBe(false);
  });

  it('inspector surfaces the confidential config', async () => {
    const inspection = await inspectMint(autoMint.address);

    expect(inspection.extensions).toContain('ConfidentialTransferMint');
    expect(inspection.confidentialTransfer).toEqual({
      authority: payer.address,
      autoApproveNewAccounts: true,
      auditorElgamalPubkey: null,
    });
    expect(inspection.supplyRaw).toBe(0n);
    expect(inspection.mintAuthority).toBe(payer.address);
  });

  it('inspector reports the public control mint as not confidential-capable', async () => {
    const inspection = await inspectMint(publicMint.address);

    expect(inspection.extensions).not.toContain('ConfidentialTransferMint');
    expect(inspection.confidentialTransfer).toBeUndefined();
  });
});
