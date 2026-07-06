// 01-create-mint-public.ts — create a STANDARD Token-2022 mint (no confidential
// extension) on the configured cluster (devnet by default), with on-chain
// name/symbol via the native TokenMetadata extension (no Metaplex needed).
//
// This is the inspector's "control group": a fully public mint whose supply and
// balances are plain u64s. Later phases create a confidential-capable mint and
// contrast the two.
//
// Extensions must be configured at creation — order matters:
//   System.createAccount            (space = mint + MetadataPointer ext;
//                                    rent covers the metadata TLV added later)
//   -> initializeMetadataPointer    (BEFORE initializeMint2; points at the mint itself)
//   -> initializeMint2              (decimals, mintAuthority)
//   -> initializeTokenMetadata      (name/symbol/uri, stored inside the mint account)
//
// Run: pnpm tsx scripts/01-create-mint-public.ts
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  lamports,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
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
  getRpcSubscriptions,
  loadKeypairSigner,
} from '../src/config';
import { saveArtifact } from '../src/artifacts';

const DECIMALS = 9;
const TOKEN_NAME = 'shashtoken';
const TOKEN_SYMBOL = 'SHASH';
const TOKEN_URI = ''; // optionally a URL to richer JSON metadata (logo, description)

async function main() {
  const rpc = getRpc();
  const rpcSubscriptions = getRpcSubscriptions();
  const payer = await loadKeypairSigner();

  console.log(`\n🪙  Creating public Token-2022 mint "${TOKEN_NAME}" (${TOKEN_SYMBOL}) on ${CLUSTER}`);
  console.log(`    payer: ${payer.address}`);

  // Fail fast if the payer can't cover rent + fees.
  const { value: balance } = await rpc.getBalance(payer.address).send();
  if (balance === 0n) {
    console.error(`\n❌ Payer has 0 SOL on ${CLUSTER}. Fund it first:`);
    console.error(`   solana airdrop 2 ${payer.address} --url ${CLUSTER}`);
    process.exit(1);
  }

  const mint = await generateKeyPairSigner();

  // The MetadataPointer ext is fixed-size and must exist at creation; the
  // TokenMetadata TLV entry is appended by the program during
  // initializeTokenMetadata, so we allocate space WITHOUT it but fund rent
  // for the full eventual size.
  const metadataPointerExt = {
    __kind: 'MetadataPointer',
    authority: payer.address,
    metadataAddress: mint.address, // metadata lives inside the mint account itself
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

  const allocatedSpace = BigInt(getMintSize([metadataPointerExt]));
  const fullSpace = BigInt(getMintSize([metadataPointerExt, tokenMetadataExt]));
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

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  // Signing erases the specific lifetime brand; re-narrow to blockhash lifetime
  // so the (blockhash-based) confirmer accepts it.
  assertIsTransactionWithBlockhashLifetime(signedTx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: 'confirmed' });
  const signature = getSignatureFromTransaction(signedTx);

  // Read the mint back from chain and print the decoded state.
  const onchain = await fetchMint(rpc, mint.address);
  const { mintAuthority, supply, decimals, isInitialized, extensions } = onchain.data;

  const extList = extensions.__option === 'Some' ? extensions.value : [];
  const metadata = extList.find((e) => e.__kind === 'TokenMetadata');

  saveArtifact('publicMint', mint.address);

  console.log(`\n✅ Public mint created and confirmed.`);
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
  console.log(`\n    tx   : ${explorerTx(signature)}`);
  console.log(`    mint : ${explorerAddress(mint.address)}`);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (publicMint)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
