// 04-inspect-account.ts — decode and print token-account state.
//
// Usage:
//   pnpm tsx scripts/04-inspect-account.ts                    # both accounts from artifacts
//   pnpm tsx scripts/04-inspect-account.ts <tokenAccountAddr> # any account you like
//
// Phase 0 this shows plain public balances — the "control group". From Phase 2
// the same inspector gains the ConfidentialTransferAccount decode, and the
// balance lines you see here become ciphertext for everyone except the key holder.
import { address } from '@solana/kit';
import { CLUSTER } from '../src/config';
import { getArtifact } from '../src/artifacts';
import { inspectTokenAccount, renderInspection } from '../src/inspector/decodeAccount';

async function main() {
  const args = process.argv.slice(2);

  const fromArtifacts = [
    { label: 'sender token account', addr: getArtifact('payerTokenAccount') },
    { label: 'recipient token account', addr: getArtifact('recipientTokenAccount') },
  ];
  const targets: Array<{ label: string; addr: string }> = args.length
    ? args.map((a, n) => ({ label: `account #${n + 1} (from args)`, addr: a }))
    : fromArtifacts.filter((t): t is { label: string; addr: string } => !!t.addr);

  if (!targets.length) {
    console.error('❌ No artifacts found and no address given. Run scripts 01-03 first,');
    console.error('   or pass a token-account address explicitly.');
    process.exit(1);
  }

  console.log(`\n🔎 Inspecting ${targets.length} account(s) on ${CLUSTER}\n`);
  for (const { label, addr } of targets) {
    renderInspection(label, await inspectTokenAccount(address(addr)));
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
