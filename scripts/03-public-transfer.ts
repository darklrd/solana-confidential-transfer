// 03-public-transfer.ts — ordinary PUBLIC transfer of tokens between two wallets.
//
// This is the transparency baseline the whole project contrasts against:
// the amount, sender, and receiver are all in plain sight on any explorer.
// From Phase 3 onward the amount disappears into ciphertext.
//
// Notes:
// - The RECIPIENT does not sign. Only the source account's owner authorizes
//   a transfer; anyone can receive (and the payer may create the recipient's
//   ATA for them — "gas-less" onboarding for the recipient).
// - transferChecked (like mintToChecked) re-asserts mint + decimals as a
//   wrong-token/wrong-scale guard.
//
// Run: pnpm tsx scripts/03-public-transfer.ts
import { address } from '@solana/kit';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from '@solana-program/token-2022';
import {
  CLUSTER,
  explorerTx,
  getRpc,
  loadKeypairSigner,
} from '../src/config';
import { getArtifact, saveArtifact } from '../src/artifacts';
import { sendInstructions } from '../src/tx';

const DECIMALS = 9;
const TRANSFER_AMOUNT_UI = 250n;
const TRANSFER_AMOUNT_RAW = TRANSFER_AMOUNT_UI * 10n ** BigInt(DECIMALS);

const ui = (raw: bigint) => `${raw / 10n ** BigInt(DECIMALS)}`;

async function main() {
  const rpc = getRpc();
  const sender = await loadKeypairSigner(); // wallet.json
  const recipient = await loadKeypairSigner('./keys/recipient.json');

  const mintAddress = getArtifact('publicMint');
  const senderAtaAddress = getArtifact('payerTokenAccount');
  if (!mintAddress || !senderAtaAddress) {
    console.error('❌ Missing artifacts. Run scripts 01 and 02 first.');
    process.exit(1);
  }
  const mint = address(mintAddress);
  const senderAta = address(senderAtaAddress);

  // Recipient's ATA: same derivation formula, their wallet as owner.
  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });

  console.log(`\n💸 Public transfer of ${TRANSFER_AMOUNT_UI} SHASH on ${CLUSTER}`);
  console.log(`    sender    : ${sender.address}`);
  console.log(`    recipient : ${recipient.address}`);

  // BEFORE snapshot (recipient ATA may not exist yet -> balance 0).
  const senderBefore = (await fetchToken(rpc, senderAta)).data.amount;
  const recipientBefore = await fetchToken(rpc, recipientAta)
    .then((t) => t.data.amount)
    .catch(() => 0n);

  const createRecipientAtaIx = await getCreateAssociatedTokenIdempotentInstructionAsync({
    payer: sender, // sender pays the rent for the recipient's account
    owner: recipient.address,
    mint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
  });
  const transferIx = getTransferCheckedInstruction({
    source: senderAta,
    mint,
    destination: recipientAta,
    authority: sender, // only the sender signs
    amount: TRANSFER_AMOUNT_RAW,
    decimals: DECIMALS,
  });

  const signature = await sendInstructions(sender, [createRecipientAtaIx, transferIx]);

  // AFTER snapshot + diff.
  const senderAfter = (await fetchToken(rpc, senderAta)).data.amount;
  const recipientAfter = (await fetchToken(rpc, recipientAta)).data.amount;

  saveArtifact('recipientTokenAccount', recipientAta);

  console.log(`\n✅ Transfer confirmed.`);
  console.log(`    sender    : ${ui(senderBefore)} -> ${ui(senderAfter)}  (Δ ${ui(senderAfter - senderBefore)})`);
  console.log(`    recipient : ${ui(recipientBefore)} -> ${ui(recipientAfter)}  (Δ +${ui(recipientAfter - recipientBefore)})`);

  if (senderBefore - senderAfter !== recipientAfter - recipientBefore) {
    console.error('❌ Deltas do not reconcile!');
    process.exit(1);
  }
  console.log(`    deltas reconcile ✓ (sender out == recipient in)`);
  console.log(`\n    tx : ${explorerTx(signature)}`);
  console.log(`    ^ open it: the amount is PLAINLY VISIBLE. This is what confidential transfers will hide.`);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (recipientTokenAccount)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
