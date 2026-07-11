// 02-create-account-public.ts — create a token account for the mint made in 01
// and mint supply into it. Uses the wallet's mintAuthority power for the first time.
//
// Two new concepts:
//
// 1. ASSOCIATED TOKEN ACCOUNT (ATA). A wallet doesn't "contain" tokens; each
//    (wallet, mint) pair gets its own token account. The ATA is the canonical
//    one: its address is DERIVED from (owner, token program, mint) — a Program
//    Derived Address (PDA). Nobody has its private key; control comes from the
//    owner field in its data. Anyone can compute the same address, so wallets
//    always know where to look.
//
// 2. MINTING. Creating new supply requires the mint's mintAuthority to sign —
//    that's the wallet (set in 01). `mintToChecked` also asserts the decimals,
//    guarding against wrong-mint / wrong-scale mistakes.
//
// The create-ATA instruction is IDEMPOTENT: safe to re-run, it no-ops if the
// account exists. Re-running this script therefore mints 1000 more SHASH into
// the same account (supply inflates; nothing else duplicates).
//
// Run: pnpm tsx scripts/02-create-account-public.ts
import { address } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToCheckedInstruction,
} from '@solana-program/token-2022';
import {
  CLUSTER,
  explorerAddress,
  explorerTx,
  getRpc,
  loadKeypairSigner,
} from '../src/config';
import { getArtifact, saveArtifact } from '../src/artifacts';
import { sendInstructions } from '../src/tx';

const DECIMALS = 9;
const MINT_AMOUNT_UI = 1000n; // whole tokens to mint per run
const MINT_AMOUNT_RAW = MINT_AMOUNT_UI * 10n ** BigInt(DECIMALS);

async function main() {
  const rpc = getRpc();
  const payer = await loadKeypairSigner();

  const mintAddress = getArtifact('publicMint');
  if (!mintAddress) {
    console.error('❌ No publicMint in artifacts. Run 01-create-mint-public.ts first.');
    process.exit(1);
  }
  const mint = address(mintAddress);

  console.log(`\n🏦 Creating token account + minting on ${CLUSTER}`);
  console.log(`    owner (wallet) : ${payer.address}`);
  console.log(`    mint           : ${mint}`);

  // Derive the ATA address — pure math, no network call, no private key.
  const [ata] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });
  console.log(`    ata (derived)  : ${ata}`);

  const createAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer,
    owner: payer.address,
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const mintToIx = getMintToCheckedInstruction({
    mint,
    token: ata,
    mintAuthority: payer, // signer: this is the printing press being used
    amount: MINT_AMOUNT_RAW,
    decimals: DECIMALS,
  });

  const signature = await sendInstructions(payer, [createAtaIx, mintToIx]);

  // Read back both sides: the token account balance and the mint's total supply.
  const [tokenAccount, mintAccount] = await Promise.all([
    fetchToken(rpc, ata),
    fetchMint(rpc, mint),
  ]);
  const ui = (raw: bigint) => `${raw / 10n ** BigInt(DECIMALS)} (raw ${raw})`;

  saveArtifact('payerTokenAccount', ata);

  console.log(`\n✅ Token account funded.`);
  console.log(`    account balance: ${ui(tokenAccount.data.amount)}`);
  console.log(`    account owner  : ${tokenAccount.data.owner}`);
  console.log(`    total supply   : ${ui(mintAccount.data.supply)}`);
  console.log(`\n    tx  : ${explorerTx(signature)}`);
  console.log(`    ata : ${explorerAddress(ata)}`);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (payerTokenAccount)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
