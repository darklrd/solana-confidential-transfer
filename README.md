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
pnpm tsx scripts/05-create-confidential-mint.ts
pnpm tsx scripts/06-inspect-mint.ts
pnpm tsx scripts/07-generate-keys.ts
pnpm tsx scripts/08-configure-account.ts
pnpm tsx scripts/09-inspect-confidential-account.ts
pnpm tsx scripts/10-deposit.ts
pnpm tsx scripts/11-decrypt-my-balance.ts

# 6. Then explore the same account interactively
pnpm ui                # Confidential Transfer Lab → http://127.0.0.1:8787
```

Tests (`pnpm test`) cover the public lifecycle plus confidential mint, account, deposit, decryption, snapshot, and diff behavior against devnet. Set `SKIP_NETWORK_TESTS=1` to run only deterministic offline coverage.

## Scripts

| Script | Concept |
|---|---|
| `00-check-env` | Toolchain, wallet, RPC, and program availability checks |
| `01-create-mint-public` | Create a Token-2022 mint with native on-chain metadata (MetadataPointer + TokenMetadata extensions — no Metaplex) |
| `02-create-account-public` | Derive the Associated Token Account (a PDA — an account with no private key), create it, mint supply |
| `03-public-transfer` | An ordinary public transfer: the transparency baseline. The amount is plainly visible on any explorer |
| `04-inspect-account` | Decode any token account: balance, state, and every extension present on the account and its mint |
| `05-create-confidential-mint` | Create a mint with the ConfidentialTransferMint extension (must be set at creation — a public mint can never be upgraded). Auto-approve by default; `--manual-approve` to gate new accounts behind the authority |
| `06-inspect-mint` | Decode any mint; renders the public and confidential mints side by side — identical except for the one extension everything confidential hangs off |
| `07-generate-keys` | Deterministically derive the owner's per-mint ElGamal and AES keys from a wallet signature; no additional secret files |
| `08-configure-account` | Create/reallocate the owner's token account and configure its ConfidentialTransferAccount extension |
| `09-inspect-confidential-account` | Decode the confidential account's ciphertext fields, credit counters, and approval state |
| `10-deposit` | Mint setup funds if needed, then move one public token into encrypted pending state; save public before/after snapshots and render the diff |
| `11-decrypt-my-balance` | Re-derive the owner's keys in memory and decrypt pending plus available balances into human-readable amounts |

## The Lab (interactive UI)

`pnpm ui` starts the **Confidential Transfer Lab** at `http://127.0.0.1:8787` — a
minimal local web UI over the same `src/` modules the scripts use (Node's
built-in `http` plus vanilla JS; zero added dependencies, no build step). It
shows the lifecycle as a stepper, runs **Deposit** and **Apply** against devnet
with one click, links every real transaction to the explorer, and renders the
account in two switchable views: **Observer** (the raw ciphertexts anyone can
see) and **Owner** (the same bytes decrypted in memory).

Security model: the server binds to `127.0.0.1` only and refuses to run against
mainnet. The wallet keypair and the derived ElGamal/AES keys live only in the
server process — the browser receives public chain state and decrypted balance
*numbers*, never key material.

## Roadmap

| Phase | Content | Status |
|---|---|---|
| 0 | Environment + transparent baseline (public mint, transfer, inspector v0) | ✅ done |
| 1 | Confidential-capable mint + mint inspector | ✅ done |
| 2 | ElGamal/AES keys + configure confidential account | ✅ done |
| 3 | Deposit (public → pending) + **owner decryption** of your own balance | ✅ done |
| 4 | Apply (pending → available): why the two-step model exists | ✅ done — live in the Lab; lesson script `12` pending |
| 5 | The confidential transfer itself: three ZK proofs, context-state accounts | — |
| 6 | Withdraw + auditor decryption + observer/owner/auditor three-views | — |
| 7 | Visual playground over saved snapshots | partially — the Lab (above) covers live interactive exploration |

## Phase 3: crossing the public/confidential boundary

`10-deposit` first ensures the configured account has one public token, captures
the public observer state, and submits Token-2022 `ConfidentialDeposit`. The
transaction's deposit amount is public because it crosses from the transparent
balance into confidential state. Afterward the public balance is lower, the
pending ciphertext has changed, the credit counter is higher, and available
balance remains untouched until Phase 4.

Public before/after snapshots are written under `snapshots/<cluster>/` and show
ciphertexts and counters only. `11-decrypt-my-balance` re-derives the owner's
per-mint keys, decrypts the pending ElGamal limbs and AES available balance in
memory, and prints the amount. Decrypted balances and derivation material are
never written to snapshots.

## Phase 4: why pending → available is a separate step

Incoming credits (deposits and, later, transfers) land in the **pending**
balance and rewrite its ciphertext. If they landed directly in **available**,
an incoming credit could invalidate a spend proof you were building against
that ciphertext. So pending absorbs credits, and `ApplyPendingBalance` — run
at a moment you choose — folds pending into available and zeroes the pending
credit counter. The instruction states the credit count it has seen (the race
guard), and it needs no ZK proof: only your AES key can compute the new
decryptable available balance.

## Key handling

Private keys live in the gitignored `keys/` directory, created by `scripts/create-wallet.sh` — which refuses to write a key to any path that isn't gitignored, validates names, and never prints secret material. Confidential ElGamal/AES keys are re-derived from domain-separated wallet signatures and remain in memory. Never log, store, or transmit those derivation signatures: possession of one can reconstruct the corresponding confidential secret key. Runtime artifacts and snapshots are gitignored; persisted snapshots intentionally reject decrypted balances. The Lab's local server follows the same rules: it binds to `127.0.0.1`, refuses mainnet, and keeps all key material in its own process. Never fund these development keypairs with mainnet assets.

## License

[MIT](./LICENSE)
