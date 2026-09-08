// 10-deposit.ts — cross the public/confidential boundary.
//
// Deposit burns down this account's ordinary public amount and homomorphically
// adds the same raw amount to its encrypted pending balance. The deposit amount
// itself is public at this boundary; later confidential transfers hide amounts.
//
// Run scripts 05, 08 first, then:
//   pnpm tsx scripts/10-deposit.ts
import { address } from '@solana/kit';
import {
  fetchMint,
  getConfidentialDepositInstruction,
  getMintToCheckedInstruction,
} from '@solana-program/token-2022';
import { getArtifact } from '../src/artifacts';
import {
  CLUSTER,
  explorerAddress,
  explorerTx,
  getRpc,
  loadKeypairSigner,
} from '../src/config';
import { formatAmount, inspectTokenAccount } from '../src/inspector/decodeAccount';
import {
  captureAccountSnapshot,
  savePublicAccountSnapshot,
} from '../src/snapshot/capture';
import {
  diffAccountSnapshots,
  renderAccountSnapshotDiff,
} from '../src/snapshot/diff';
import { sendInstructions } from '../src/tx';

const DEPOSIT_AMOUNT_UI = 1n;
const MAXIMUM_DEPOSIT_RAW = (1n << 48n) - 1n;

async function main() {
  const rpc = getRpc();
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
  if (!initial.confidential.approved) throw new Error('Token account is awaiting mint-authority approval.');

  const mintAccount = await fetchMint(rpc, mint);
  const decimals = mintAccount.data.decimals;
  const depositAmountRaw = DEPOSIT_AMOUNT_UI * 10n ** BigInt(decimals);
  if (!initial.confidential.allowConfidentialCredits) {
    throw new Error('Token account rejects confidential deposits and transfers.');
  }
  if (
    initial.confidential.pendingBalanceCreditCounter >=
    initial.confidential.maximumPendingBalanceCreditCounter
  ) {
    throw new Error('Pending credit counter is full; apply the pending balance before depositing.');
  }
  if (depositAmountRaw > MAXIMUM_DEPOSIT_RAW) {
    throw new Error('Deposit exceeds Token-2022’s maximum raw amount of 2^48 - 1.');
  }

  console.log(`\n📥 Depositing ${formatAmount(depositAmountRaw, decimals)} ${initial.mintInfo.symbol ?? 'tokens'} into confidential pending on ${CLUSTER}`);
  console.log(`    owner   : ${payer.address}`);
  console.log(`    account : ${token}`);

  if (initial.amountRaw < depositAmountRaw) {
    const shortfall = depositAmountRaw - initial.amountRaw;
    console.log(
      `\n    setup: minting ${formatAmount(shortfall, decimals)} public tokens so the walkthrough is re-runnable`,
    );
    const fundingSignature = await sendInstructions(payer, [
      getMintToCheckedInstruction({
        mint,
        token,
        mintAuthority: payer,
        amount: shortfall,
        decimals,
      }),
    ]);
    console.log(`    funding tx: ${explorerTx(fundingSignature)}`);
  }

  const before = await captureAccountSnapshot('before confidential deposit', token);
  const supplyBefore = (await fetchMint(rpc, mint)).data.supply;
  const signature = await sendInstructions(payer, [
    getConfidentialDepositInstruction({
      token,
      mint,
      authority: payer,
      amount: depositAmountRaw,
      decimals,
    }),
  ]);
  const after = await captureAccountSnapshot('after confidential deposit', token);
  const supplyAfter = (await fetchMint(rpc, mint)).data.supply;
  const diff = diffAccountSnapshots(before, after);

  if (BigInt(diff.publicBalance.delta) !== -depositAmountRaw) {
    throw new Error('Deposit did not reduce the public balance by the requested amount.');
  }
  if (
    !diff.confidential ||
    (!diff.confidential.pendingBalanceLow.changed &&
      !diff.confidential.pendingBalanceHigh.changed)
  ) {
    throw new Error('Deposit did not change the encrypted pending balance.');
  }
  if (diff.confidential.pendingCreditCounter.delta !== '1') {
    throw new Error('Deposit did not increment the pending credit counter exactly once.');
  }
  if (
    diff.confidential.maximumPendingCreditCounter.direction !== 'unchanged' ||
    diff.confidential.expectedPendingCreditCounter.direction !== 'unchanged' ||
    diff.confidential.actualPendingCreditCounter.direction !== 'unchanged'
  ) {
    throw new Error('Deposit changed counters reserved for ApplyPendingBalance.');
  }
  if (
    diff.confidential.availableBalance.changed ||
    diff.confidential.decryptableAvailableBalance.changed
  ) {
    throw new Error('Deposit changed available balance before ApplyPendingBalance.');
  }
  if (supplyBefore !== supplyAfter) {
    throw new Error('Deposit changed mint supply instead of moving existing tokens.');
  }

  const beforeFile = savePublicAccountSnapshot(before, '10-deposit-before');
  const afterFile = savePublicAccountSnapshot(after, '10-deposit-after');

  renderAccountSnapshotDiff(before, after, diff);
  console.log(`\n✅ Deposit confirmed. Public amount moved into encrypted pending state.`);
  console.log(`    mint supply unchanged: ${supplyAfter}`);
  console.log(`    tx      : ${explorerTx(signature)}`);
  console.log(`    account : ${explorerAddress(token)}`);
  console.log(`    snapshots: ${beforeFile}, ${afterFile}`);
  console.log(`\n    The deposit amount is visible in this boundary transaction.`);
  console.log(`    The resulting pending balance is ciphertext to a public observer.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
