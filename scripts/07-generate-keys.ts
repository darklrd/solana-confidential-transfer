// 07-generate-keys.ts — derive the confidential-transfer keys for the wallet
// and the confidential mint (Phase 2). Nothing touches the chain.
//
// "Generate" is really DERIVE: both keys come from a wallet signature over a
// deterministic, domain-separated message bound to (owner, mint) — see
// src/keys.ts. Consequences worth noticing:
//   - nothing to store: re-derive on demand; the wallet keypair is the backup
//   - per-mint isolation: the same wallet gets different keys per mint
//   - owner-only: producing the keys requires the owner's signature, so no
//     third party can configure an account with keys it controls
//
// Two keys, two jobs:
//   - ElGamal keypair — encrypts pending/available balances on-chain; its
//     32-byte pubkey is PUBLIC (stored in the account at configure, script 08)
//   - AES-128 key     — encrypts the "decryptable available balance", the
//     owner's fast path to reading their own balance without solving
//     ElGamal discrete logs
//
// Run: pnpm tsx scripts/07-generate-keys.ts
import { address } from '@solana/kit';
import { CLUSTER } from '../src/config';
import { getArtifact, saveArtifact } from '../src/artifacts';
import { loadKeypairSigner } from '../src/config';
import { deriveConfidentialKeys } from '../src/keys';

async function main() {
  const wallet = await loadKeypairSigner();

  const mintAddr = getArtifact('confidentialMint');
  if (!mintAddr) {
    console.error('❌ No confidentialMint artifact. Run scripts/05-create-confidential-mint.ts first.');
    process.exit(1);
  }
  const mint = address(mintAddr);

  console.log(`\n🔑 Deriving confidential-transfer keys (${CLUSTER} artifacts)`);
  console.log(`    wallet : ${wallet.address}`);
  console.log(`    mint   : ${mint}`);
  console.log(`\n    No key file is written — both keys derive from a wallet signature`);
  console.log(`    over a domain-separated message seeded with (owner ‖ mint).`);

  const keys = await deriveConfidentialKeys(wallet, mint);

  console.log(`\n✅ ElGamal keypair derived`);
  console.log(`    pubkey : ${keys.elgamalPubkey}`);
  console.log(`             (public — script 08 stores it on-chain in the token account)`);
  console.log(`    secret : held in memory only; never printed, never written`);

  console.log(`\n✅ AES-128 key derived (for the owner-only decryptable balance)`);
  console.log(`    secret : 16 bytes, held in memory only`);

  // Determinism: an independent second derivation must land on the same keys.
  const again = await deriveConfidentialKeys(wallet, mint);
  console.log(`\n    determinism    : re-derived → ${again.elgamalPubkey === keys.elgamalPubkey ? 'identical ✓' : 'MISMATCH ✗'}`);

  // Isolation: the same wallet derives a DIFFERENT key for another mint.
  const publicMint = getArtifact('publicMint');
  if (publicMint) {
    const other = await deriveConfidentialKeys(wallet, address(publicMint));
    console.log(`    mint isolation : public mint (01) → ${other.elgamalPubkey === keys.elgamalPubkey ? 'SAME KEY ✗' : 'different key ✓'}`);
  }

  saveArtifact('ownerElgamalPubkey', keys.elgamalPubkey);
  console.log(`\n    saved -> artifacts/${CLUSTER}.json  (ownerElgamalPubkey)\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
