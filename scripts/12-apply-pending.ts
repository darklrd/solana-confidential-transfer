// 12-apply-pending.ts — fold the encrypted pending balance into available.
//
// Deposits (and, later, incoming transfers) only touch pending, so a credit
// can never invalidate a spend proof built against available. Apply is the
// owner's explicit step to make pending spendable: it needs no ZK proof,
// because only the owner's AES key can produce the new decryptable balance,
// and it states the credit count it has seen so late credits are detectable.
//
// Run scripts 05, 08, 10 first, then:
//   pnpm tsx scripts/12-apply-pending.ts
import { address, type Address } from '@solana/kit';
import { assertApplyTransition, prepareApplyPendingBalance } from '../src/apply';
import { getArtifact } from '../src/artifacts';
import { CLUSTER, explorerAddress, explorerTx, loadKeypairSigner } from '../src/config';
import { formatAmount, inspectTokenAccount } from '../src/inspector/decodeAccount';
import { decryptConfidentialBalances } from '../src/inspector/decrypt';
import { deriveConfidentialKeys, type ConfidentialKeys } from '../src/keys';
import {
  createAccountSnapshot,
  savePublicAccountSnapshot,
  type AccountSnapshot,
} from '../src/snapshot/capture';
import {
  diffAccountSnapshots,
  renderAccountSnapshotDiff,
} from '../src/snapshot/diff';
import { sendInstructions } from '../src/tx';

/**
 * One fetch, two views: the public observer snapshot that may be persisted,
 * and the owner-decrypted one that stays in memory for the diff.
 */
async function captureBothViews(
  label: string,
  token: Address,
  keys: ConfidentialKeys,
): Promise<{ observer: AccountSnapshot; owner: AccountSnapshot }> {
  const inspection = await inspectTokenAccount(token);
  const timestamp = new Date().toISOString();
  return {
    observer: createAccountSnapshot(label, inspection, undefined, timestamp),
    owner: createAccountSnapshot(
      label,
      inspection,
      { by: 'owner', ...decryptConfidentialBalances(inspection, keys) },
      timestamp,
    ),
  };
}

async function main() {
  const payer = await loadKeypairSigner();
  const mintArtifact = getArtifact('confidentialMint');
  const tokenArtifact = getArtifact('payerConfidentialTokenAccount');
  if (!mintArtifact || !tokenArtifact) {
    console.error('❌ Missing Phase 2 artifacts. Run scripts 05 and 08 first.');
    process.exit(1);
  }

  const mint = address(mintArtifact);
  const token = address(tokenArtifact);
  const initial = await inspectTokenAccount(token);
  if (initial.mint !== mint) throw new Error('Configured token account belongs to a different mint.');
  if (initial.owner !== payer.address) throw new Error('Configured token account belongs to a different owner.');
  if (!initial.confidential) throw new Error('Token account is not configured for confidential transfers.');
  if (initial.confidential.pendingBalanceCreditCounter === 0n) {
    console.error('❌ Nothing pending to apply. Run scripts/10-deposit.ts first.');
    process.exit(1);
  }

  const keys = await deriveConfidentialKeys(payer, mint);
  try {
    const before = await captureBothViews('before apply pending', token, keys);
    const { decimals, symbol } = initial.mintInfo;
    const unit = symbol ?? 'tokens';
    const pendingCredits = before.owner.confidential!.pendingCreditCounter;
    const pendingRaw = BigInt(before.owner.confidential!.decrypted!.pendingRaw);

    console.log(`\n🔁 Applying pending → available on ${CLUSTER}`);
    console.log(`    owner   : ${payer.address}`);
    console.log(`    account : ${token}`);
    console.log(
      `    pending : ${formatAmount(pendingRaw, decimals)} ${unit} across ${pendingCredits} credit(s) (owner-decrypted, in memory)`,
    );

    const { instruction, expectedCreditCounter } = await prepareApplyPendingBalance(token, payer, keys);
    if (expectedCreditCounter.toString() !== pendingCredits) {
      throw new Error('A credit landed while preparing the apply; re-run to apply the latest state.');
    }
    console.log(`    stating expectedPendingBalanceCreditCounter = ${expectedCreditCounter}`);

    const signature = await sendInstructions(payer, [instruction]);
    const after = await captureBothViews('after apply pending', token, keys);
    const diff = diffAccountSnapshots(before.owner, after.owner);
    assertApplyTransition(diff, expectedCreditCounter);

    const beforeFile = savePublicAccountSnapshot(before.observer, '12-apply-before');
    const afterFile = savePublicAccountSnapshot(after.observer, '12-apply-after');

    renderAccountSnapshotDiff(before.owner, after.owner, diff);
    console.log(`\n✅ Apply confirmed. Pending folded into available; no ZK proof was needed.`);
    console.log(`    tx      : ${explorerTx(signature)}`);
    console.log(`    account : ${explorerAddress(token)}`);
    console.log(`    snapshots (observer view only): ${beforeFile}, ${afterFile}`);
    console.log(`\n    An observer sees the pending ciphertext reset and the available ciphertext change,`);
    console.log(`    but not the amount. The decrypted rows above exist only in this process.\n`);
  } finally {
    keys.elgamalKeypair.free();
    keys.aeKey.free();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
