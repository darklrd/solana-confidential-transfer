// inspector/decodeAccount.ts — decode a Token-2022 token account (plus its
// mint, for context) into a human-readable structure.
//
// This is the project's spine (F1). Phase 0 scope: public fields + detected
// extensions. Phase 2+ extends this to decode ConfidentialTransferAccount
// ciphertexts; Phase 3 wraps it in the snapshot/diff model (TDD §3).
import {
  AccountState,
  fetchMint,
  fetchToken,
  type Extension,
} from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
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

function extensionKinds(extensions: { __option: 'Some'; value: Extension[] } | { __option: 'None' }): string[] {
  return extensions.__option === 'Some' ? extensions.value.map((e) => e.__kind) : [];
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
  console.log(`│  mint          : ${i.mint}`);
  console.log(
    `│    ${i.mintInfo.name ?? '(unnamed)'} (${i.mintInfo.symbol ?? '?'}) · decimals ${i.mintInfo.decimals} · supply ${i.mintInfo.supplyUi}`,
  );
  console.log(`│    mint exts   : ${i.mintInfo.extensions.join(', ') || '(none)'}`);
  console.log(`└─`);
}
