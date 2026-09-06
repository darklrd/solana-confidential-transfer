// Phase 2 specs — keys + configure account.
//
// Offline (always runs): key derivation is deterministic, (owner, mint)-
// scoped, and the reconstructed WASM keypair matches the derived pubkey —
// the "keys persist and reload" property, which for derive-from-signer
// means: re-derivation IS the reload.
//
// Network (skip with SKIP_NETWORK_TESTS=1): a fresh throwaway confidential
// mint + the create-confidential-account plan; asserts the on-chain
// ConfidentialTransferAccount layout (TDD §5 Phase 2 DoD).
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSigner, getAddressEncoder, type KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMint2Instruction,
  getMintSize,
} from '@solana-program/token-2022';
import { getCreateConfidentialTransferAccountInstructionPlan } from '@solana-program/token-2022/confidential';
import { getRpc, loadKeypairSigner } from '../src/config';
import { executeInstructionPlan, sendInstructions } from '../src/tx';
import { deriveConfidentialKeys } from '../src/keys';
import { inspectTokenAccount } from '../src/inspector/decodeAccount';

const ZERO_B64_64 = Buffer.alloc(64).toString('base64'); // empty ElGamal ciphertext
const ZERO_B64_36 = Buffer.alloc(36).toString('base64'); // empty AE ciphertext

describe('confidential key derivation (offline)', () => {
  it('is deterministic and scoped to (owner, mint)', async () => {
    const wallet = await generateKeyPairSigner();
    const mintA = (await generateKeyPairSigner()).address;
    const mintB = (await generateKeyPairSigner()).address;

    const first = await deriveConfidentialKeys(wallet, mintA);
    const again = await deriveConfidentialKeys(wallet, mintA);
    const other = await deriveConfidentialKeys(wallet, mintB);
    const stranger = await deriveConfidentialKeys(await generateKeyPairSigner(), mintA);

    expect(again.elgamalPubkey).toBe(first.elgamalPubkey);
    expect(Buffer.from(again.aeKey.toBytes())).toEqual(Buffer.from(first.aeKey.toBytes()));
    expect(other.elgamalPubkey).not.toBe(first.elgamalPubkey);
    expect(stranger.elgamalPubkey).not.toBe(first.elgamalPubkey);
  });

  it('reconstructs a WASM keypair consistent with the derived pubkey', async () => {
    const wallet = await generateKeyPairSigner();
    const mint = (await generateKeyPairSigner()).address;

    const keys = await deriveConfidentialKeys(wallet, mint);
    const pubkeyBytes = new Uint8Array(keys.elgamalKeypair.pubkey().toBytes());
    const addressBytes = new Uint8Array(getAddressEncoder().encode(keys.elgamalPubkey));

    expect(Buffer.from(pubkeyBytes)).toEqual(Buffer.from(addressBytes));
  });
});

describe.skipIf(process.env.SKIP_NETWORK_TESTS === '1')('configure confidential account', () => {
  const rpc = getRpc();
  const DECIMALS = 9;
  let payer: KeyPairSigner;
  let mint: KeyPairSigner;

  beforeAll(async () => {
    payer = await loadKeypairSigner();
    const { value: balance } = await rpc.getBalance(payer.address).send();
    expect(balance, 'payer must hold SOL — fund the wallet first').toBeGreaterThan(0n);

    mint = await generateKeyPairSigner();

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
        decimals: DECIMALS,
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
  });

  it('lands the ConfidentialTransferAccount extension with the derived pubkey', async () => {
    const [token] = await findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mint.address,
    });
    const keys = await deriveConfidentialKeys(payer, mint.address);

    const onchain = await fetchToken(rpc, token);
    const exts = onchain.data.extensions.__option === 'Some' ? onchain.data.extensions.value : [];
    const ct = exts.find((e) => e.__kind === 'ConfidentialTransferAccount');
    expect(ct, 'extension must be present').toBeDefined();
    if (!ct || ct.__kind !== 'ConfidentialTransferAccount') throw new Error('unreachable');

    expect(ct.approved).toBe(true); // mint auto-approves
    expect(ct.elgamalPubkey).toBe(keys.elgamalPubkey);
    expect(ct.allowConfidentialCredits).toBe(true);
    expect(ct.allowNonConfidentialCredits).toBe(true);
    expect(ct.pendingBalanceCreditCounter).toBe(0n);
    expect(ct.maximumPendingBalanceCreditCounter).toBe(65536n);
  });

  it('inspector renders the pristine encrypted layout (all-zero ciphertexts)', async () => {
    const [token] = await findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mint.address,
    });

    const inspection = await inspectTokenAccount(token);
    expect(inspection.accountExtensions).toContain('ConfidentialTransferAccount');
    const c = inspection.confidential;
    expect(c).toBeDefined();
    if (!c) throw new Error('unreachable');

    expect(c.approved).toBe(true);
    expect(c.pendingBalanceLow).toBe(ZERO_B64_64);
    expect(c.pendingBalanceHigh).toBe(ZERO_B64_64);
    expect(c.availableBalance).toBe(ZERO_B64_64);
    // The decryptable balance is AES(0) under the owner's key — real
    // ciphertext, NOT zero bytes (decrypting it is Phase 3's job).
    expect(c.decryptableAvailableBalance).not.toBe(ZERO_B64_36);
    expect(inspection.amountRaw).toBe(0n); // public balance untouched
  });
});
