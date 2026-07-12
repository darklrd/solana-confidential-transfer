// 06-inspect-mint.ts — decode and print mint state, side by side.
//
// Usage:
//   pnpm tsx scripts/06-inspect-mint.ts             # both mints from artifacts
//   pnpm tsx scripts/06-inspect-mint.ts <mintAddr>  # any mint you like
//
// With no args this renders the public mint (01) next to the confidential
// mint (05): identical shape, except one carries ConfidentialTransferMint.
// That one extension — fixed forever at creation — is the entire difference
// between a mint whose amounts must stay public and one whose accounts can
// opt into encrypted balances (Phase 2).
import { address } from '@solana/kit';
import { CLUSTER } from '../src/config';
import { getArtifact } from '../src/artifacts';
import { inspectMint, renderMintInspection } from '../src/inspector/decodeMint';

async function main() {
  const args = process.argv.slice(2);

  const fromArtifacts = [
    { label: 'public mint (script 01)', addr: getArtifact('publicMint') },
    { label: 'confidential mint (script 05)', addr: getArtifact('confidentialMint') },
  ];
  const targets: Array<{ label: string; addr: string }> = args.length
    ? args.map((a, n) => ({ label: `mint #${n + 1} (from args)`, addr: a }))
    : fromArtifacts.filter((t): t is { label: string; addr: string } => !!t.addr);

  if (!targets.length) {
    console.error('❌ No artifacts found and no address given. Run scripts 01 and 05 first,');
    console.error('   or pass a mint address explicitly.');
    process.exit(1);
  }

  console.log(`\n🔎 Inspecting ${targets.length} mint(s) on ${CLUSTER}\n`);
  const inspections = [];
  for (const { label, addr } of targets) {
    const inspection = await inspectMint(address(addr));
    renderMintInspection(label, inspection);
    inspections.push(inspection);
  }

  if (!args.length && inspections.length === 2) {
    console.log(`\n👀 Same program, same metadata layout — the only structural difference is`);
    console.log(`   the ConfidentialTransferMint entry in the extension list. Everything`);
    console.log(`   confidential in later phases hangs off that one TLV entry.`);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
