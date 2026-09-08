// 11-decrypt-my-balance.ts — owner view of a confidential token account.
//
// A public observer can fetch the same account but sees ciphertext. The owner
// re-derives the ElGamal/AES keys from the wallet signature and recovers the
// pending and available amounts without writing keys or plaintext snapshots.
//
// Run scripts 05, 08, 10 first, then:
//   pnpm tsx scripts/11-decrypt-my-balance.ts
import { address } from '@solana/kit';
import { getArtifact } from '../src/artifacts';
import { CLUSTER, loadKeypairSigner } from '../src/config';
import {
  formatAmount,
  inspectTokenAccount,
  renderInspection,
} from '../src/inspector/decodeAccount';
import {
  decryptConfidentialBalances,
  type DecryptedConfidentialBalances,
} from '../src/inspector/decrypt';
import { deriveConfidentialKeys } from '../src/keys';

async function main() {
  const payer = await loadKeypairSigner();
  const tokenArtifact = getArtifact('payerConfidentialTokenAccount');
  if (!tokenArtifact) {
    console.error('❌ No confidential account artifact. Run scripts 05, 08, and 10 first.');
    process.exit(1);
  }

  const token = address(tokenArtifact);
  const inspection = await inspectTokenAccount(token);
  if (inspection.owner !== payer.address) {
    throw new Error('Configured token account does not belong to the loaded wallet.');
  }
  if (!inspection.confidential) {
    throw new Error('Token account is not configured for confidential transfers.');
  }

  console.log(`\n🔓 Owner view on ${CLUSTER}`);
  renderInspection('public observer view', inspection);
  console.log(`\n    deriving owner keys from a wallet signature; no key file is read or written…`);

  const keys = await deriveConfidentialKeys(payer, address(inspection.mint));
  let balances: DecryptedConfidentialBalances;
  try {
    balances = decryptConfidentialBalances(inspection, keys);
  } finally {
    keys.elgamalKeypair.free();
    keys.aeKey.free();
  }
  const { decimals, symbol } = inspection.mintInfo;
  const unit = symbol ?? 'tokens';

  console.log(`\n┌─ owner-decrypted balances`);
  console.log(
    `│  pending   : ${formatAmount(balances.pendingRaw, decimals)} ${unit} (raw ${balances.pendingRaw})`,
  );
  console.log(
    `│  available : ${formatAmount(balances.availableRaw, decimals)} ${unit} (raw ${balances.availableRaw})`,
  );
  console.log(`└─`);
  console.log(`\n✅ The owner recovered the number hidden behind the pending ciphertext.`);
  console.log(`   Plaintext and derived keys remained in memory and were not saved.\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
