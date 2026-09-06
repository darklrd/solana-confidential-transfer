// 08-configure-account.ts — opt the wallet's token account into confidential
// transfers on the confidential mint (Phase 2).
//
// A confidential-capable MINT (script 05) is not enough: each token ACCOUNT
// opts in separately. The official instruction plan does it in one atomic
// transaction:
//   1. create the ATA (idempotent)
//   2. Reallocate       — grow the account for the ConfidentialTransferAccount
//                         extension (extensions on ACCOUNTS can be added after
//                         creation, unlike mint extensions)
//   3. ConfigureAccount — store the ElGamal pubkey + an AES-encrypted zero as
//                         the initial decryptable balance
//   4. VerifyPubkeyValidity — ZK proof, checked by Token-2022 via the
//                         instruction sysvar (proofInstructionOffset = 1),
//                         that we hold the ElGamal secret key for that pubkey.
//                         Without it you could configure an account with a
//                         pubkey nobody can decrypt — unusable forever.
//
// The keys are re-DERIVED from the wallet signature (script 07) — nothing is
// read from disk. Only the owner can sign, so only the owner can configure.
//
// Run: pnpm tsx scripts/08-configure-account.ts
import { getCreateConfidentialTransferAccountInstructionPlan } from '@solana-program/token-2022/confidential';
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMaybeToken,
  fetchToken,
  findAssociatedTokenPda,
} from '@solana-program/token-2022';
import { address } from '@solana/kit';
import {
  CLUSTER,
  explorerAddress,
  explorerTx,
  getRpc,
  loadKeypairSigner,
} from '../src/config';
import { getArtifact, saveArtifact } from '../src/artifacts';
import { deriveConfidentialKeys } from '../src/keys';
import { executeInstructionPlan } from '../src/tx';
import { inspectTokenAccount, renderInspection } from '../src/inspector/decodeAccount';

async function main() {
  const rpc = getRpc();
  const payer = await loadKeypairSigner();

  const mintAddr = getArtifact('confidentialMint');
  if (!mintAddr) {
    console.error('❌ No confidentialMint artifact. Run scripts/05-create-confidential-mint.ts first.');
    process.exit(1);
  }
  const mint = address(mintAddr);

  const [token] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    mint,
  });

  console.log(`\n🛡️  Configuring a confidential token account on ${CLUSTER}`);
  console.log(`    owner : ${payer.address}`);
  console.log(`    mint  : ${mint}`);
  console.log(`    ata   : ${token}`);

  // Re-runnable: if the ATA already carries the extension, there is nothing
  // to do (ConfigureAccount cannot run twice on the same account).
  const existing = await fetchMaybeToken(rpc, token);
  if (existing.exists) {
    const exts =
      existing.data.extensions.__option === 'Some' ? existing.data.extensions.value : [];
    if (exts.some((e) => e.__kind === 'ConfidentialTransferAccount')) {
      console.log(`\n✅ Already configured — the account carries ConfidentialTransferAccount.`);
      renderInspection('current state', await inspectTokenAccount(token));
      return;
    }
  }

  console.log(`\n    deriving ElGamal + AES keys from the wallet signature (as in 07)…`);
  const keys = await deriveConfidentialKeys(payer, mint);
  console.log(`    elgamal pubkey: ${keys.elgamalPubkey}`);

  const plan = await getCreateConfidentialTransferAccountInstructionPlan({
    payer,
    owner: payer,
    mint,
    rpc,
    elgamalKeypair: keys.elgamalKeypair,
    aesKey: keys.aeKey,
  });
  const signatures = await executeInstructionPlan(payer, plan);

  // Read back and verify what landed on-chain.
  const onchain = await fetchToken(rpc, token);
  const exts = onchain.data.extensions.__option === 'Some' ? onchain.data.extensions.value : [];
  const ct = exts.find((e) => e.__kind === 'ConfidentialTransferAccount');
  if (!ct || ct.__kind !== 'ConfidentialTransferAccount') {
    console.error('❌ ConfidentialTransferAccount extension missing after configure!');
    process.exit(1);
  }
  if (ct.elgamalPubkey !== keys.elgamalPubkey) {
    console.error('❌ On-chain ElGamal pubkey differs from the derived one!');
    process.exit(1);
  }

  saveArtifact('payerConfidentialTokenAccount', token);

  console.log(`\n✅ Account configured for confidential transfers (${signatures.length} tx).`);
  console.log(`    approved       : ${ct.approved} ${ct.approved ? '(mint auto-approves new accounts)' : '(awaiting authority approval)'}`);
  console.log(`    elgamalPubkey  : ${ct.elgamalPubkey} — matches the derived key ✓`);
  console.log(`    all ciphertexts start as zero bytes; the decryptable balance is AES(0)`);

  renderInspection('after configure', await inspectTokenAccount(token));

  for (const sig of signatures) console.log(`    tx  : ${explorerTx(sig)}`);
  console.log(`    ata : ${explorerAddress(token)}`);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (payerConfidentialTokenAccount)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
