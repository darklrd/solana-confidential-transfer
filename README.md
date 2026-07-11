# solana-confidential-transfer

A step-by-step TypeScript walkthrough of **Solana Token-2022 Confidential Transfers** — built script-by-script on official Solana libraries, with a **state inspector** that shows you exactly what is hidden (and what isn't) at every stage of the lifecycle.

## Why this exists

Solana's Token-2022 program supports **confidential balances**: token amounts encrypted with twisted-ElGamal encryption and verified on-chain by the ZK ElGamal Proof program. But developers trying to learn it hit three walls:

1. The canonical reference implementation is **Rust-only**.
2. **Nothing shows you the encrypted state** — the standard `spl-token` CLI has no decrypt option, so a confidential balance looks like opaque ciphertext bytes.
3. The pending/available two-step model and the three-proof transfer are hard to follow without inspecting state between steps.

This project fills that gap with small, runnable TypeScript scripts — one concept each — plus an inspector that decodes (and, where you hold the keys, **decrypts**) confidential state into human-readable numbers.

## ⚠️ Confidentiality ≠ anonymity

Confidential transfers hide **amounts and balances** — nothing else. The sender, receiver, mint, and the fact that a transfer happened remain fully public. This is not a mixer or an anonymity tool; the transaction graph stays visible by design, and mints can optionally name an **auditor** key that can decrypt amounts for compliance.

## Principles

- **Official libraries to the maximum extent** — [`@solana/kit`](https://github.com/anza-xyz/kit), [`@solana-program/token-2022`](https://github.com/solana-program/token-2022), and [`@solana/zk-sdk`](https://www.npmjs.com/package/@solana/zk-sdk) (the WASM build of the Rust `solana-zk-sdk`). No hand-rolled cryptography.
- **Devnet-primary** — the ZK ElGamal Proof program and updated Token-2022 are enabled on devnet, so everything runs against a public cluster you can verify in any explorer. A local validator remains a one-line `.env` fallback.
- **One script = one concept**, and every state-changing script prints the before/after so you can watch the chain state mutate.

## Quickstart

Prereqs: Node ≥ 20, [pnpm](https://pnpm.io), the [Solana CLI](https://docs.anza.xyz/cli/install), and a shell.

```bash
git clone https://github.com/darklrd/solana-confidential-transfer.git
cd solana-confidential-transfer
pnpm install

# 1. Create a wallet (written to gitignored keys/, never committed)
./scripts/create-wallet.sh

# 2. Fund it on devnet (or use https://faucet.solana.com)
solana airdrop 2 <YOUR_ADDRESS> --url devnet

# 3. Configure
cp .env.example .env   # devnet by default

# 4. Verify your environment
pnpm check-env

# 5. Run the scripts in order
pnpm tsx scripts/01-create-mint-public.ts
pnpm tsx scripts/02-create-account-public.ts
pnpm tsx scripts/03-public-transfer.ts
pnpm tsx scripts/04-inspect-account.ts
```

Tests (`pnpm test`) run the full public lifecycle against devnet on a fresh throwaway mint. Set `SKIP_NETWORK_TESTS=1` to run only the pure unit tests.

## Scripts

| Script | Concept |
|---|---|
| `00-check-env` | Toolchain, wallet, RPC, and program availability checks |
| `01-create-mint-public` | Create a Token-2022 mint with native on-chain metadata (MetadataPointer + TokenMetadata extensions — no Metaplex) |
| `02-create-account-public` | Derive the Associated Token Account (a PDA — an account with no private key), create it, mint supply |
| `03-public-transfer` | An ordinary public transfer: the transparency baseline. The amount is plainly visible on any explorer |
| `04-inspect-account` | Decode any token account: balance, state, and every extension present on the account and its mint |

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Environment + transparent baseline (public mint, transfer, inspector v0) | ✅ done |
| 1 | Confidential-capable mint + mint inspector | ⏳ next |
| 2 | ElGamal/AES keys + configure confidential account | — |
| 3 | Deposit (public → pending) + **owner decryption** of your own balance | — |
| 4 | Apply (pending → available): why the two-step model exists | — |
| 5 | The confidential transfer itself: three ZK proofs, context-state accounts | — |
| 6 | Withdraw + auditor decryption + observer/owner/auditor three-views | — |
| 7 | Visual playground over saved snapshots | — |

## Key handling

Private keys live in the gitignored `keys/` directory, created by `scripts/create-wallet.sh` — which refuses to write a key to any path that isn't gitignored, validates names, and never prints secret material. Never fund these development keypairs with mainnet assets.

## License

[MIT](./LICENSE)
