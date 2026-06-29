// 00-check-env.ts — Phase 0 DoD: assert toolchain, wallet, and (if up) the
// local validator with the Token-2022 program loaded. Prints pinned versions.
//
// Run: pnpm check-env
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getRpc,
  loadKeypairSigner,
  PROGRAM_IDS,
  RPC_URL,
  WALLET_KEYPAIR_PATH,
} from '../src/config';

const ok = (m: string) => console.log(`  ✅ ${m}`);
const warn = (m: string) => console.log(`  ⚠️  ${m}`);
const bad = (m: string) => console.log(`  ❌ ${m}`);

function tryCmd(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function pkgVersion(pkg: string): string | null {
  try {
    const pj = JSON.parse(
      readFileSync(resolve('node_modules', pkg, 'package.json'), 'utf8'),
    ) as { version: string };
    return pj.version;
  } catch {
    return null;
  }
}

async function main() {
  console.log('\n🔍 cipherflow — Phase 0 environment check\n');
  let blocking = false;

  // 1. Toolchain
  console.log('Toolchain:');
  ok(`node ${process.version}`);
  const pnpmV = tryCmd('pnpm', ['--version']);
  if (pnpmV) ok(`pnpm ${pnpmV}`);
  else warn('pnpm not found on PATH');
  const solanaV = tryCmd('solana', ['--version']);
  if (solanaV) ok(solanaV);
  else {
    bad('Solana CLI not found — install from https://docs.anza.xyz/cli/install');
    blocking = true;
  }

  // 2. Pinned libraries
  console.log('\nPinned libraries:');
  for (const pkg of ['@solana/kit', '@solana-program/token-2022', '@solana/zk-sdk']) {
    const v = pkgVersion(pkg);
    if (v) ok(`${pkg} ${v}`);
    else warn(`${pkg} not installed — run pnpm install`);
  }

  // 3. Wallet
  console.log('\nWallet:');
  if (!existsSync(resolve(WALLET_KEYPAIR_PATH))) {
    bad(`keypair not found at ${WALLET_KEYPAIR_PATH} — run ./scripts/create-wallet.sh`);
    blocking = true;
  } else {
    try {
      const signer = await loadKeypairSigner();
      ok(`loaded ${WALLET_KEYPAIR_PATH}`);
      ok(`address ${signer.address}`);
    } catch (e) {
      bad(`failed to load keypair: ${(e as Error).message}`);
      blocking = true;
    }
  }

  // 4. Validator
  console.log(`\nValidator (${RPC_URL}):`);
  const rpc = getRpc();
  try {
    const v = await rpc.getVersion().send();
    ok(`reachable — solana-core ${v['solana-core']}`);
    try {
      const info = await rpc
        .getAccountInfo(PROGRAM_IDS.token2022, { encoding: 'base64' })
        .send();
      if (info.value?.executable)
        ok(`Token-2022 program loaded (${PROGRAM_IDS.token2022})`);
      else
        warn(`Token-2022 program not found at ${PROGRAM_IDS.token2022} — clone it into the validator`);
    } catch (e) {
      warn(`could not query Token-2022 program: ${(e as Error).message}`);
    }
  } catch {
    warn('not reachable — start one with: solana-test-validator');
    warn('(expected if you have not started a local validator yet)');
  }

  console.log('');
  if (blocking) {
    console.log('❌ Environment has blocking issues (see ❌ above).\n');
    process.exit(1);
  }
  console.log('✅ Core toolchain OK. Start a validator to run the lifecycle scripts.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
