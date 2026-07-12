// inspector/decodeMint.ts — decode a Token-2022 MINT into a human-readable
// structure, including the ConfidentialTransferMint config when present.
//
// Phase 1 scope (F1): base mint fields + extension kinds + the mint-level
// confidential config (authority / auto-approve / auditor). This is where the
// public/confidential contrast starts: two mints, identical except one carries
// the extension — and it can only ever carry it from creation, never added.
// Phase 2 extends the ACCOUNT decoder with the encrypted balance layout.
import { fetchMint, type Extension } from '@solana-program/token-2022';
import type { Address } from '@solana/kit';
import { getRpc } from '../config';
import { extensionKinds, formatAmount } from './decodeAccount';

export type MintInspection = {
  address: string;
  decimals: number;
  supplyRaw: bigint;
  supplyUi: string;
  isInitialized: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  name?: string;
  symbol?: string;
  /** Token-2022 extensions present on the mint. */
  extensions: string[];
  /** Present iff the mint carries the ConfidentialTransferMint extension. */
  confidentialTransfer?: {
    /** May update this config and (in manual mode) approve new accounts. */
    authority: string | null;
    /** true: configured accounts usable immediately; false: authority approves each. */
    autoApproveNewAccounts: boolean;
    /** Can decrypt every transfer amount; null = no auditor configured. */
    auditorElgamalPubkey: string | null;
  };
};

const optionToNull = (o: { __option: 'Some'; value: unknown } | { __option: 'None' }) =>
  o.__option === 'Some' ? String(o.value) : null;

/** Fetch + decode a mint. */
export async function inspectMint(mintAddress: Address): Promise<MintInspection> {
  const rpc = getRpc();
  const mint = await fetchMint(rpc, mintAddress);

  const extList = mint.data.extensions.__option === 'Some' ? mint.data.extensions.value : [];
  const metadata = extList.find(
    (e): e is Extension & { __kind: 'TokenMetadata' } => e.__kind === 'TokenMetadata',
  );
  const confidential = extList.find(
    (e): e is Extension & { __kind: 'ConfidentialTransferMint' } =>
      e.__kind === 'ConfidentialTransferMint',
  );

  return {
    address: mint.address,
    decimals: mint.data.decimals,
    supplyRaw: mint.data.supply,
    supplyUi: formatAmount(mint.data.supply, mint.data.decimals),
    isInitialized: mint.data.isInitialized,
    mintAuthority: optionToNull(mint.data.mintAuthority),
    freezeAuthority: optionToNull(mint.data.freezeAuthority),
    name: metadata?.name,
    symbol: metadata?.symbol,
    extensions: extensionKinds(mint.data.extensions),
    confidentialTransfer: confidential && {
      authority: optionToNull(confidential.authority),
      autoApproveNewAccounts: confidential.autoApproveNewAccounts,
      auditorElgamalPubkey: optionToNull(confidential.auditorElgamalPubkey),
    },
  };
}

/** Pretty-print a mint inspection to the console. */
export function renderMintInspection(label: string, i: MintInspection): void {
  console.log(`┌─ ${label}`);
  console.log(`│  mint          : ${i.address}`);
  console.log(`│  name / symbol : ${i.name ?? '(unnamed)'} (${i.symbol ?? '?'})`);
  console.log(`│  decimals      : ${i.decimals} · supply ${i.supplyUi} (raw ${i.supplyRaw})`);
  console.log(`│  initialized   : ${i.isInitialized}`);
  console.log(`│  mintAuthority : ${i.mintAuthority ?? '(none)'}`);
  console.log(`│  freezeAuth    : ${i.freezeAuthority ?? '(none)'}`);
  console.log(`│  extensions    : ${i.extensions.join(', ') || '(none)'}`);
  if (i.confidentialTransfer) {
    const ct = i.confidentialTransfer;
    console.log(`│  ConfidentialTransferMint ✓ — confidential-capable`);
    console.log(`│    authority              : ${ct.authority ?? '(none — config frozen)'}`);
    console.log(
      `│    autoApproveNewAccounts : ${ct.autoApproveNewAccounts} ${
        ct.autoApproveNewAccounts
          ? '(new accounts usable immediately)'
          : '(authority must approve each account)'
      }`,
    );
    console.log(
      `│    auditorElgamalPubkey   : ${ct.auditorElgamalPubkey ?? '(none — only owners can decrypt)'}`,
    );
  } else {
    console.log(`│  confidential  : ✗ not capable — extension absent, and it cannot`);
    console.log(`│                  be added after creation (script 05 explains why)`);
  }
  console.log(`└─`);
}
