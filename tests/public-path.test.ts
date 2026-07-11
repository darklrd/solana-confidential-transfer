// Phase 0 integration spec — the full PUBLIC lifecycle against a live cluster
// (devnet by default). Creates a fresh throwaway mint + accounts every run so
// it is idempotent and never touches the artifacts used by the numbered
// scripts. Skip with SKIP_NETWORK_TESTS=1.
//
// Asserted properties (TDD §6):
//   - mint decodes with the expected config + metadata extensions
//   - minted balance == intended amount; supply reconciles
//   - sender delta == recipient delta for the transfer
//   - the inspector decodes it all correctly
import { beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSigner, type Address, type KeyPairSigner } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeTokenMetadataInstruction,
  getMintSize,
  getMintToCheckedInstruction,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import { getRpc, loadKeypairSigner } from '../src/config';
import { sendInstructions } from '../src/tx';
import { inspectTokenAccount } from '../src/inspector/decodeAccount';

const DECIMALS = 9;
const MINTED = 5n * 10n ** BigInt(DECIMALS); // 5 tokens
const SENT = 2n * 10n ** BigInt(DECIMALS); // 2 tokens
const NAME = 'sct-test';
const SYMBOL = 'SCT';

const rpc = getRpc();
let payer: KeyPairSigner;
let mint: KeyPairSigner;
let payerAta: Address;
let recipient: KeyPairSigner;
let recipientAta: Address;

describe.skipIf(process.env.SKIP_NETWORK_TESTS === '1')('public token lifecycle', () => {
  beforeAll(async () => {
    payer = await loadKeypairSigner();
    const { value: balance } = await rpc.getBalance(payer.address).send();
    expect(balance, 'payer must hold SOL — fund the wallet first').toBeGreaterThan(0n);

    mint = await generateKeyPairSigner();
    recipient = await generateKeyPairSigner(); // ephemeral; never signs, needs no SOL
  });

  it('creates a Token-2022 mint with native metadata', async () => {
    const metadataPointerExt = {
      __kind: 'MetadataPointer',
      authority: payer.address,
      metadataAddress: mint.address,
    } as const;
    const tokenMetadataExt = {
      __kind: 'TokenMetadata',
      updateAuthority: payer.address,
      mint: mint.address,
      name: NAME,
      symbol: SYMBOL,
      uri: '',
      additionalMetadata: new Map<string, string>(),
    } as const;

    const space = BigInt(getMintSize([metadataPointerExt]));
    const fullSpace = BigInt(getMintSize([metadataPointerExt, tokenMetadataExt]));
    const rent = await rpc.getMinimumBalanceForRentExemption(fullSpace).send();

    await sendInstructions(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getInitializeMetadataPointerInstruction({
        mint: mint.address,
        authority: payer.address,
        metadataAddress: mint.address,
      }),
      getInitializeMint2Instruction({
        mint: mint.address,
        decimals: DECIMALS,
        mintAuthority: payer.address,
        freezeAuthority: null,
      }),
      getInitializeTokenMetadataInstruction({
        metadata: mint.address,
        updateAuthority: payer.address,
        mint: mint.address,
        mintAuthority: payer,
        name: NAME,
        symbol: SYMBOL,
        uri: '',
      }),
    ]);

    const onchain = await fetchMint(rpc, mint.address);
    expect(onchain.data.isInitialized).toBe(true);
    expect(onchain.data.decimals).toBe(DECIMALS);
    expect(onchain.data.supply).toBe(0n);
    expect(onchain.data.mintAuthority).toEqual({ __option: 'Some', value: payer.address });

    const exts =
      onchain.data.extensions.__option === 'Some' ? onchain.data.extensions.value : [];
    expect(exts.map((e) => e.__kind)).toEqual(
      expect.arrayContaining(['MetadataPointer', 'TokenMetadata']),
    );
    const md = exts.find((e) => e.__kind === 'TokenMetadata');
    expect(md && md.__kind === 'TokenMetadata' && md.name).toBe(NAME);
    expect(md && md.__kind === 'TokenMetadata' && md.symbol).toBe(SYMBOL);
  });

  it('creates the ATA and mints the intended amount', async () => {
    [payerAta] = await findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mint.address,
    });

    await sendInstructions(payer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: payer.address,
        mint: mint.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getMintToCheckedInstruction({
        mint: mint.address,
        token: payerAta,
        mintAuthority: payer,
        amount: MINTED,
        decimals: DECIMALS,
      }),
    ]);

    const token = await fetchToken(rpc, payerAta);
    expect(token.data.amount).toBe(MINTED);
    expect(token.data.owner).toBe(payer.address);

    // supply reconciles with the single holder's balance
    const onchainMint = await fetchMint(rpc, mint.address);
    expect(onchainMint.data.supply).toBe(MINTED);
  });

  it('transfers with sender delta == recipient delta', async () => {
    [recipientAta] = await findAssociatedTokenPda({
      owner: recipient.address,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      mint: mint.address,
    });

    const senderBefore = (await fetchToken(rpc, payerAta)).data.amount;

    await sendInstructions(payer, [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: recipient.address,
        mint: mint.address,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      }),
      getTransferCheckedInstruction({
        source: payerAta,
        mint: mint.address,
        destination: recipientAta,
        authority: payer,
        amount: SENT,
        decimals: DECIMALS,
      }),
    ]);

    const senderAfter = (await fetchToken(rpc, payerAta)).data.amount;
    const recipientAfter = (await fetchToken(rpc, recipientAta)).data.amount;

    expect(senderBefore - senderAfter).toBe(SENT);
    expect(recipientAfter).toBe(SENT);
    // conservation: no tokens created or destroyed by a transfer
    expect(senderAfter + recipientAfter).toBe(MINTED);
  });

  it('inspector decodes the resulting state correctly', async () => {
    const inspection = await inspectTokenAccount(recipientAta);

    expect(inspection.amountRaw).toBe(SENT);
    expect(inspection.amountUi).toBe('2');
    expect(inspection.owner).toBe(recipient.address);
    expect(inspection.state).toBe('Initialized');
    expect(inspection.accountExtensions).toContain('ImmutableOwner');
    expect(inspection.mintInfo.name).toBe(NAME);
    expect(inspection.mintInfo.symbol).toBe(SYMBOL);
    expect(inspection.mintInfo.supplyUi).toBe('5');
    expect(inspection.mintInfo.extensions).toEqual(
      expect.arrayContaining(['MetadataPointer', 'TokenMetadata']),
    );
  });
});
