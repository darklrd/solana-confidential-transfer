#!/usr/bin/env bash
#
# create-wallet.sh — generate a local Solana keypair for cipherflow.
#
# The SECRET key is written to ./keys/ which is gitignored. The public address
# is safe to share. This script refuses to write a secret unless the target
# path is actually gitignored, so you can't accidentally commit a private key.
#
# Usage:
#   ./scripts/create-wallet.sh            # creates keys/wallet.json
#   ./scripts/create-wallet.sh auditor    # creates keys/auditor.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

KEYS_DIR="$ROOT_DIR/keys"
WALLET_NAME="${1:-wallet}"
WALLET_PATH="$KEYS_DIR/$WALLET_NAME.json"

mkdir -p "$KEYS_DIR"
chmod 700 "$KEYS_DIR"

# --- Safety: never write a secret that isn't gitignored ---
if command -v git >/dev/null 2>&1 && git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! git -C "$ROOT_DIR" check-ignore -q "$WALLET_PATH"; then
    echo "❌ Refusing to write a secret: $WALLET_PATH is NOT gitignored."
    echo "   Add 'keys/' to .gitignore before generating keys."
    exit 1
  fi
fi

# --- Don't clobber an existing key (it may be funded) ---
if [[ -f "$WALLET_PATH" ]]; then
  echo "❌ Keypair already exists: $WALLET_PATH"
  echo "   Refusing to overwrite. Use a different name, e.g.:"
  echo "   ./scripts/create-wallet.sh ${WALLET_NAME}-2"
  exit 1
fi

echo "🔑 Generating new Solana keypair -> keys/$WALLET_NAME.json"
# --silent suppresses the recovery seed phrase so it never lands in terminal
# scrollback / logs. Remove --silent if you want a BIP39 mnemonic to back up.
solana-keygen new \
  --outfile "$WALLET_PATH" \
  --no-bip39-passphrase \
  --silent

chmod 600 "$WALLET_PATH"

PUBKEY="$(solana-keygen pubkey "$WALLET_PATH")"
echo ""
echo "✅ Wallet created."
echo "   Public address (safe to share) : $PUBKEY"
echo "   Secret key file (NEVER commit)  : keys/$WALLET_NAME.json"
echo ""
echo "   Verify it's ignored by git:  git check-ignore keys/$WALLET_NAME.json"
