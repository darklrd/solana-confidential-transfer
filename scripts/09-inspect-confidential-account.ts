// 09-inspect-confidential-account.ts — render the encrypted account layout
// (Phase 2).
//
// Usage:
//   pnpm tsx scripts/09-inspect-confidential-account.ts          # from artifacts
//   pnpm tsx scripts/09-inspect-confidential-account.ts <addr>   # any account
//
// What the layout means (and why the balance is split three ways):
//   - pending (lo/hi)  — incoming amounts land here, ElGamal-encrypted under
//     the account's pubkey. Split into low/high bits because ElGamal
//     decryption must brute-force a discrete log: keeping each ciphertext's
//     plaintext range small keeps decryption feasible (Phase 3).
//   - available        — the spendable balance, also ElGamal-encrypted; only
//     moves when the owner runs ApplyPendingBalance (Phase 4 explains why
//     the two-step exists).
//   - decryptable      — an AES copy of the available balance that only the
//     owner can read cheaply; the owner's fast path around discrete logs.
//
// Right now every ciphertext is zero bytes — the account is configured but
// unused. From Phase 3 on, these fields fill with real ciphertext and THIS
// view is what a public observer is left staring at.
import { address } from '@solana/kit';
import { CLUSTER } from '../src/config';
import { getArtifact } from '../src/artifacts';
import { inspectTokenAccount, renderInspection } from '../src/inspector/decodeAccount';

async function main() {
  const args = process.argv.slice(2);

  const artifact = getArtifact('payerConfidentialTokenAccount');
  const targets: Array<{ label: string; addr: string }> = args.length
    ? args.map((a, n) => ({ label: `account #${n + 1} (from args)`, addr: a }))
    : artifact
      ? [{ label: 'confidential token account (script 08)', addr: artifact }]
      : [];

  if (!targets.length) {
    console.error('❌ No artifact found and no address given. Run scripts 05, 08 first,');
    console.error('   or pass a token-account address explicitly.');
    process.exit(1);
  }

  console.log(`\n🔎 Inspecting ${targets.length} confidential account(s) on ${CLUSTER}\n`);
  for (const { label, addr } of targets) {
    const inspection = await inspectTokenAccount(address(addr));
    renderInspection(label, inspection);
    if (!inspection.confidential) {
      console.log(`\n⚠️  This account has NO ConfidentialTransferAccount extension —`);
      console.log(`    it is a plain public account. Run scripts/08-configure-account.ts.`);
    }
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
