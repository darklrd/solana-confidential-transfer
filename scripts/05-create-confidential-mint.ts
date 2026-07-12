// 05-create-confidential-mint.ts — create a Token-2022 mint WITH the
// ConfidentialTransferMint extension: the first confidential-capable mint of
// the walkthrough (Phase 1).
//
// Contrast with 01-create-mint-public.ts: identical metadata setup, one extra
// extension. The extension only makes the mint *capable* of confidential
// transfers — token accounts still opt in individually (Phase 2), and amounts
// only become hidden once deposited (Phase 3). Like all mint extensions it is
// fixed at creation: a public mint can never be upgraded to confidential.
//
// The extension carries three fields:
//   authority              — may update this config later and, in manual mode,
//                            approves each newly configured account. We use the
//                            payer so later phases can update the config.
//   autoApproveNewAccounts — true by default here: accounts configured for
//                            confidential use work immediately. Pass
//                            --manual-approve to require per-account approval
//                            by the authority (compliance-style gating).
//   auditorElgamalPubkey   — optional key able to decrypt every transfer
//                            amount. None for now; unlike the extension itself
//                            the authority CAN set this later, which Phase 6
//                            uses for the auditor story.
//
// Extensions must be configured at creation — order matters:
//   System.createAccount                  (space = mint + MetadataPointer
//                                          + ConfidentialTransferMint;
//                                          rent covers the metadata TLV too)
//   -> initializeMetadataPointer          (BEFORE initializeMint2)
//   -> initializeConfidentialTransferMint (BEFORE initializeMint2)
//   -> initializeMint2                    (decimals, mintAuthority)
//   -> initializeTokenMetadata            (name/symbol, stored inside the mint)
//
// Run: pnpm tsx scripts/05-create-confidential-mint.ts [--manual-approve]
import { generateKeyPairSigner, lamports } from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  getInitializeConfidentialTransferMintInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeTokenMetadataInstruction,
  getMintSize,
} from '@solana-program/token-2022';
import {
  CLUSTER,
  explorerAddress,
  explorerTx,
  getRpc,
  loadKeypairSigner,
} from '../src/config';
import { saveArtifact } from '../src/artifacts';
import { sendInstructions } from '../src/tx';

const DECIMALS = 9;
const TOKEN_NAME = 'shashConfidential';
const TOKEN_SYMBOL = 'cSHASH';
const TOKEN_URI = '';

const AUTO_APPROVE = !process.argv.includes('--manual-approve');

async function main() {
  const rpc = getRpc();
  const payer = await loadKeypairSigner();

  console.log(`\n🔐 Creating CONFIDENTIAL-capable Token-2022 mint "${TOKEN_NAME}" (${TOKEN_SYMBOL}) on ${CLUSTER}`);
  console.log(`    payer: ${payer.address}`);
  console.log(`    new-account policy: ${AUTO_APPROVE ? 'auto-approve' : 'manual approval by authority'}`);

  // Fail fast if the payer can't cover rent + fees.
  const { value: balance } = await rpc.getBalance(payer.address).send();
  if (balance === 0n) {
    console.error(`\n❌ Payer has 0 SOL on ${CLUSTER}. Fund it first:`);
    console.error(`   solana airdrop 2 ${payer.address} --url ${CLUSTER}`);
    process.exit(1);
  }

  const mint = await generateKeyPairSigner();

  const metadataPointerExt = {
    __kind: 'MetadataPointer',
    authority: payer.address,
    metadataAddress: mint.address, // metadata lives inside the mint account itself
  } as const;
  // Fixed-size TLV entry (65 bytes): both Options encode as 32 zeroable bytes,
  // so size does not depend on whether authority/auditor are set.
  const confidentialTransferMintExt = {
    __kind: 'ConfidentialTransferMint',
    authority: payer.address,
    autoApproveNewAccounts: AUTO_APPROVE,
    auditorElgamalPubkey: null, // no auditor yet — Phase 6 sets one
  } as const;
  const tokenMetadataExt = {
    __kind: 'TokenMetadata',
    updateAuthority: payer.address,
    mint: mint.address,
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    uri: TOKEN_URI,
    additionalMetadata: new Map<string, string>(),
  } as const;

  // Allocate space for the fixed-size extensions only; the TokenMetadata TLV
  // is appended by the program during initializeTokenMetadata, so we fund
  // rent for the full eventual size (same pattern as script 01).
  const allocatedSpace = BigInt(getMintSize([metadataPointerExt, confidentialTransferMintExt]));
  const fullSpace = BigInt(
    getMintSize([metadataPointerExt, confidentialTransferMintExt, tokenMetadataExt]),
  );
  const rent = await rpc.getMinimumBalanceForRentExemption(fullSpace).send();

  const instructions = [
    getCreateAccountInstruction({
      payer,
      newAccount: mint,
      lamports: lamports(rent),
      space: allocatedSpace,
      programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    }),
    getInitializeMetadataPointerInstruction({
      mint: mint.address,
      authority: payer.address,
      metadataAddress: mint.address,
    }),
    getInitializeConfidentialTransferMintInstruction({
      mint: mint.address,
      authority: payer.address,
      autoApproveNewAccounts: AUTO_APPROVE,
      auditorElgamalPubkey: null,
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
      name: TOKEN_NAME,
      symbol: TOKEN_SYMBOL,
      uri: TOKEN_URI,
    }),
  ];

  const signature = await sendInstructions(payer, instructions);

  // Read the mint back from chain and print the decoded state.
  const onchain = await fetchMint(rpc, mint.address);
  const { mintAuthority, supply, decimals, isInitialized, extensions } = onchain.data;

  const extList = extensions.__option === 'Some' ? extensions.value : [];
  const metadata = extList.find((e) => e.__kind === 'TokenMetadata');
  const confidential = extList.find((e) => e.__kind === 'ConfidentialTransferMint');
  if (!confidential || confidential.__kind !== 'ConfidentialTransferMint') {
    console.error('❌ ConfidentialTransferMint extension missing from the created mint!');
    process.exit(1);
  }

  saveArtifact('confidentialMint', mint.address);

  console.log(`\n✅ Confidential-capable mint created and confirmed.`);
  console.log(`    mint address  : ${mint.address}`);
  console.log(`    owner program : ${onchain.programAddress}`);
  console.log(`    decimals      : ${decimals}`);
  console.log(`    supply        : ${supply}`);
  console.log(`    initialized   : ${isInitialized}`);
  console.log(
    `    mintAuthority : ${mintAuthority.__option === 'Some' ? mintAuthority.value : '(none)'}`,
  );
  console.log(`    extensions    : ${extList.map((e) => e.__kind).join(', ') || '(none)'}`);
  if (metadata && metadata.__kind === 'TokenMetadata') {
    console.log(`    name / symbol : ${metadata.name} / ${metadata.symbol}`);
  }

  console.log(`\n    ConfidentialTransferMint config:`);
  console.log(
    `      authority              : ${confidential.authority.__option === 'Some' ? confidential.authority.value : '(none)'}`,
  );
  console.log(`      autoApproveNewAccounts : ${confidential.autoApproveNewAccounts}`);
  console.log(
    `      auditorElgamalPubkey   : ${confidential.auditorElgamalPubkey.__option === 'Some' ? confidential.auditorElgamalPubkey.value : '(none — no auditor; Phase 6 adds one)'}`,
  );

  console.log(`\n    tx   : ${explorerTx(signature)}`);
  console.log(`    mint : ${explorerAddress(mint.address)}`);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (confidentialMint)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
