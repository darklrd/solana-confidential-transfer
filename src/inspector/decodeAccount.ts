// inspector/decodeAccount.ts — decode a Token-2022 token account (plus its
// mint, for context) into a human-readable structure.
//
// This is the project's spine (F1). Phase 0: public fields + detected
// extensions. Phase 2 (here): the ConfidentialTransferAccount layout —
// ciphertexts rendered as ciphertexts, which is exactly the point: this is
// what EVERYONE sees. Phase 3 adds owner decryption; Phase 3 also wraps it
// in the snapshot/diff model (TDD §3).
import {
  AccountState,
  fetchMint,
  fetchToken,
  type Extension,
} from '@solana-program/token-2022';
import type { Address, ReadonlyUint8Array } from '@solana/kit';
import { getRpc } from '../config';

export type TokenAccountInspection = {
  address: string;
  mint: string;
  owner: string;
  /** Raw integer amount (10^decimals units per token). */
  amountRaw: bigint;
  /** Human-readable amount, decimals applied. */
  amountUi: string;
  state: string;
  delegate: string | null;
  closeAuthority: string | null;
  /** Token-2022 extensions present on the token ACCOUNT. */
  accountExtensions: string[];
  /** Present iff the account carries the ConfidentialTransferAccount extension. */
  confidential?: {
    /** false on manual-approve mints until the authority approves the account. */
    approved: boolean;
    /** The owner's ElGamal pubkey, fixed at configure time. */
    elgamalPubkey: string;
    /** Twisted-ElGamal ciphertexts (base64). All-zero = encryption of 0. */
    pendingBalanceLow: string;
    pendingBalanceHigh: string;
    availableBalance: string;
    /** AES ciphertext (base64) — the owner's fast-path balance copy. */
    decryptableAvailableBalance: string;
    allowConfidentialCredits: boolean;
    allowNonConfidentialCredits: boolean;
    pendingBalanceCreditCounter: bigint;
    maximumPendingBalanceCreditCounter: bigint;
    expectedPendingBalanceCreditCounter: bigint;
    actualPendingBalanceCreditCounter: bigint;
  };
  /** Context from the mint this account holds. */
  mintInfo: {
    decimals: number;
    supplyRaw: bigint;
    supplyUi: string;
    name?: string;
    symbol?: string;
    /** Token-2022 extensions present on the MINT. */
    extensions: string[];
  };
};

export function formatAmount(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function extensionKinds(extensions: { __option: 'Some'; value: Extension[] } | { __option: 'None' }): string[] {
  return extensions.__option === 'Some' ? extensions.value.map((e) => e.__kind) : [];
}

const toBase64 = (bytes: ReadonlyUint8Array) => Buffer.from(bytes).toString('base64');

/** Render a base64 ciphertext for humans; call out the all-zero placeholder. */
function formatCiphertext(b64: string): string {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.every((b) => b === 0)) return `(${bytes.length} zero bytes — encryption of 0)`;
  const s = b64.replace(/=+$/, '');
  return `${s.slice(0, 22)}…${s.slice(-8)} (${bytes.length} bytes)`;
}

/** Fetch + decode a token account and its mint. */
export async function inspectTokenAccount(
  tokenAccountAddress: Address,
): Promise<TokenAccountInspection> {
  const rpc = getRpc();
  const token = await fetchToken(rpc, tokenAccountAddress);
  const mint = await fetchMint(rpc, token.data.mint);

  const { decimals } = mint.data;
  const metadata = extensionKinds(mint.data.extensions).includes('TokenMetadata')
    ? (mint.data.extensions as { __option: 'Some'; value: Extension[] }).value.find(
        (e): e is Extension & { __kind: 'TokenMetadata' } => e.__kind === 'TokenMetadata',
      )
    : undefined;

  const accountExtList =
    token.data.extensions.__option === 'Some' ? token.data.extensions.value : [];
  const ct = accountExtList.find(
    (e): e is Extension & { __kind: 'ConfidentialTransferAccount' } =>
      e.__kind === 'ConfidentialTransferAccount',
  );

  return {
    address: token.address,
    mint: token.data.mint,
    owner: token.data.owner,
    amountRaw: token.data.amount,
    amountUi: formatAmount(token.data.amount, decimals),
    state: AccountState[token.data.state],
    delegate: token.data.delegate.__option === 'Some' ? token.data.delegate.value : null,
    closeAuthority:
      token.data.closeAuthority.__option === 'Some' ? token.data.closeAuthority.value : null,
    accountExtensions: extensionKinds(token.data.extensions),
    confidential: ct && {
      approved: ct.approved,
      elgamalPubkey: ct.elgamalPubkey,
      pendingBalanceLow: toBase64(ct.pendingBalanceLow),
      pendingBalanceHigh: toBase64(ct.pendingBalanceHigh),
      availableBalance: toBase64(ct.availableBalance),
      decryptableAvailableBalance: toBase64(ct.decryptableAvailableBalance),
      allowConfidentialCredits: ct.allowConfidentialCredits,
      allowNonConfidentialCredits: ct.allowNonConfidentialCredits,
      pendingBalanceCreditCounter: ct.pendingBalanceCreditCounter,
      maximumPendingBalanceCreditCounter: ct.maximumPendingBalanceCreditCounter,
      expectedPendingBalanceCreditCounter: ct.expectedPendingBalanceCreditCounter,
      actualPendingBalanceCreditCounter: ct.actualPendingBalanceCreditCounter,
    },
    mintInfo: {
      decimals,
      supplyRaw: mint.data.supply,
      supplyUi: formatAmount(mint.data.supply, decimals),
      name: metadata?.name,
      symbol: metadata?.symbol,
      extensions: extensionKinds(mint.data.extensions),
    },
  };
}

/** Pretty-print an inspection to the console. */
export function renderInspection(label: string, i: TokenAccountInspection): void {
  const sym = i.mintInfo.symbol ?? 'tokens';
  console.log(`┌─ ${label}`);
  console.log(`│  token account : ${i.address}`);
  console.log(`│  owner (wallet): ${i.owner}`);
  console.log(`│  balance       : ${i.amountUi} ${sym}  (raw ${i.amountRaw})`);
  console.log(`│  state         : ${i.state}`);
  if (i.delegate) console.log(`│  delegate      : ${i.delegate}`);
  if (i.closeAuthority) console.log(`│  closeAuthority: ${i.closeAuthority}`);
  console.log(`│  account exts  : ${i.accountExtensions.join(', ') || '(none)'}`);
  if (i.confidential) {
    const c = i.confidential;
    console.log(`│  ConfidentialTransferAccount ${c.approved ? '✓ approved' : '✗ NOT approved (awaiting authority)'}`);
    console.log(`│    elgamalPubkey    : ${c.elgamalPubkey}`);
    console.log(`│    pending (lo)     : ${formatCiphertext(c.pendingBalanceLow)}`);
    console.log(`│    pending (hi)     : ${formatCiphertext(c.pendingBalanceHigh)}`);
    console.log(`│    available        : ${formatCiphertext(c.availableBalance)}`);
    console.log(`│    decryptable      : ${formatCiphertext(c.decryptableAvailableBalance)} [AES, owner-only]`);
    console.log(`│    credits allowed  : confidential ${c.allowConfidentialCredits ? '✓' : '✗'} · non-confidential ${c.allowNonConfidentialCredits ? '✓' : '✗'}`);
    console.log(`│    pending counter  : ${c.pendingBalanceCreditCounter} of max ${c.maximumPendingBalanceCreditCounter}`);
    console.log(`│    last apply       : expected ${c.expectedPendingBalanceCreditCounter} / actual ${c.actualPendingBalanceCreditCounter}`);
  }
  console.log(`│  mint          : ${i.mint}`);
  console.log(
    `│    ${i.mintInfo.name ?? '(unnamed)'} (${i.mintInfo.symbol ?? '?'}) · decimals ${i.mintInfo.decimals} · supply ${i.mintInfo.supplyUi}`,
  );
  console.log(`│    mint exts   : ${i.mintInfo.extensions.join(', ') || '(none)'}`);
  console.log(`└─`);
}
