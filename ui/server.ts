// ui/server.ts — the Confidential Transfer Lab: a minimal localhost UI over
// the same src/ modules the numbered scripts use.
//
//   pnpm ui   →  http://127.0.0.1:8787
//
// Security model (keep it this way when extending):
//   - Listens on 127.0.0.1 ONLY. Never bind 0.0.0.0.
//   - The wallet keypair and the derived ElGamal/AES keys live in this process.
//     The browser receives public chain state plus decrypted balance NUMBERS
//     (the owner view — exactly what script 11 prints). No key bytes, no
//     derivation signatures, no env values ever cross the HTTP boundary.
//   - Refuses to run against mainnet-beta.
import { createServer, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { address, type Address } from '@solana/kit';
import {
  getConfidentialDepositInstruction,
  getMintToCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';
import { ApplyPreconditionError, prepareApplyPendingBalance } from '../src/apply';
import { getArtifact } from '../src/artifacts';
import { CLUSTER, explorerAddress, explorerTx, getRpc, loadKeypairSigner } from '../src/config';
import { deriveConfidentialKeys, type ConfidentialKeys } from '../src/keys';
import { formatAmount, inspectTokenAccount } from '../src/inspector/decodeAccount';
import { decryptConfidentialBalances } from '../src/inspector/decrypt';
import { sendInstructions } from '../src/tx';

const HOST = '127.0.0.1';
const PORT = Number(process.env.UI_PORT ?? 8787);
const MAXIMUM_DEPOSIT_RAW = (1n << 48n) - 1n;

if (CLUSTER === 'mainnet-beta') {
  console.error('❌ Refusing to run the learning UI against mainnet-beta.');
  process.exit(1);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Loaded once at startup; the keys stay in process memory for the server's lifetime.
let payer: Awaited<ReturnType<typeof loadKeypairSigner>>;
let mint: Address;
let token: Address;
let keys: ConfidentialKeys;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** GET /api/state — one payload carrying both the observer and the owner view. */
async function readState() {
  const inspection = await inspectTokenAccount(token);
  let owner: { pendingRaw: bigint; pendingUi: string; availableRaw: bigint; availableUi: string } | null = null;
  let ownerError: string | undefined;
  if (inspection.confidential) {
    try {
      const d = decryptConfidentialBalances(inspection, keys);
      const { decimals } = inspection.mintInfo;
      owner = {
        pendingRaw: d.pendingRaw,
        pendingUi: formatAmount(d.pendingRaw, decimals),
        availableRaw: d.availableRaw,
        availableUi: formatAmount(d.availableRaw, decimals),
      };
    } catch (e) {
      ownerError = e instanceof Error ? e.message : 'Decryption failed.';
    }
  }
  return {
    cluster: CLUSTER,
    wallet: payer.address,
    explorer: { account: explorerAddress(token), mint: explorerAddress(mint) },
    inspection,
    owner,
    ownerError,
  };
}

/** GET /api/transactions — real history for the token account + mint. */
async function readTransactions() {
  const rpc = getRpc();
  const lists = await Promise.all(
    [token, mint].map((a) => rpc.getSignaturesForAddress(a, { limit: 10 }).send()),
  );
  const bySig = new Map<string, (typeof lists)[number][number]>();
  for (const list of lists) {
    for (const entry of list) if (!bySig.has(entry.signature)) bySig.set(entry.signature, entry);
  }
  const entries = [...bySig.values()]
    .sort((a, b) => Number(b.slot - a.slot))
    .slice(0, 10);

  const transactions = await Promise.all(
    entries.map(async (entry) => {
      let instructions: string[] = [];
      try {
        const tx = await rpc
          .getTransaction(entry.signature, {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
          })
          .send();
        const ixs = (tx?.transaction.message.instructions ?? []) as ReadonlyArray<{
          programId?: string;
          parsed?: { type?: string } | string;
        }>;
        instructions = ixs
          .map((ix) =>
            typeof ix.parsed === 'object' && ix.parsed?.type
              ? ix.parsed.type
              : ix.programId === TOKEN_2022_PROGRAM_ADDRESS
                ? 'token-2022'
                : null,
          )
          .filter((n): n is string => n !== null);
      } catch {
        // Instruction names are decoration; the signature link still works.
      }
      return {
        signature: entry.signature,
        instructions,
        failed: entry.err !== null,
        time: entry.blockTime != null ? new Date(Number(entry.blockTime) * 1000).toISOString() : null,
        explorer: explorerTx(entry.signature),
      };
    }),
  );
  return { transactions };
}

/** POST /api/apply — Phase 4: fold pending into available. Same logic as script 12. */
async function doApply() {
  let prepared: Awaited<ReturnType<typeof prepareApplyPendingBalance>>;
  try {
    prepared = await prepareApplyPendingBalance(token, payer, keys);
  } catch (e) {
    if (e instanceof ApplyPreconditionError) throw new HttpError(400, e.message);
    throw e;
  }
  const signature = await sendInstructions(payer, [prepared.instruction]);
  return { signature, explorer: explorerTx(signature) };
}

/** POST /api/deposit — same logic as script 10, minus the snapshot files. */
async function doDeposit(amountInput: unknown) {
  let amountUi: bigint;
  try {
    amountUi = BigInt(typeof amountInput === 'number' || typeof amountInput === 'string' ? amountInput : 1);
  } catch {
    throw new HttpError(400, 'Deposit amount must be a whole number of tokens.');
  }
  if (amountUi < 1n || amountUi > 1000n) {
    throw new HttpError(400, 'Deposit amount must be between 1 and 1000 tokens.');
  }

  const inspection = await inspectTokenAccount(token);
  const c = inspection.confidential;
  if (!c) throw new HttpError(400, 'Account is not configured for confidential transfers.');
  if (!c.approved) throw new HttpError(400, 'Account is awaiting mint-authority approval.');
  if (!c.allowConfidentialCredits) throw new HttpError(400, 'Account rejects confidential credits.');
  if (c.pendingBalanceCreditCounter >= c.maximumPendingBalanceCreditCounter) {
    throw new HttpError(400, 'Pending credit counter is full — apply the pending balance first.');
  }
  const { decimals } = inspection.mintInfo;
  const amountRaw = amountUi * 10n ** BigInt(decimals);
  if (amountRaw > MAXIMUM_DEPOSIT_RAW) throw new HttpError(400, 'Deposit exceeds the 2^48 - 1 raw-unit cap.');

  // Top up the public balance first if needed (payer is the mint authority on
  // this learning mint), so the walkthrough stays re-runnable — as in script 10.
  let fundingSignature: string | undefined;
  if (inspection.amountRaw < amountRaw) {
    fundingSignature = await sendInstructions(payer, [
      getMintToCheckedInstruction({
        mint,
        token,
        mintAuthority: payer,
        amount: amountRaw - inspection.amountRaw,
        decimals,
      }),
    ]);
  }

  const signature = await sendInstructions(payer, [
    getConfidentialDepositInstruction({ token, mint, authority: payer, amount: amountRaw, decimals }),
  ]);
  return {
    signature,
    explorer: explorerTx(signature),
    fundingSignature,
    fundingExplorer: fundingSignature && explorerTx(fundingSignature),
  };
}

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 10_000) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Request body must be JSON.');
  }
}

const server = createServer((req, res) => {
  void (async () => {
    const path = new URL(req.url ?? '/', `http://${HOST}`).pathname;
    if (req.method === 'GET' && path === '/') {
      const html = await readFile(fileURLToPath(new URL('./index.html', import.meta.url)), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && path === '/api/state') {
      sendJson(res, 200, await readState());
    } else if (req.method === 'GET' && path === '/api/transactions') {
      sendJson(res, 200, await readTransactions());
    } else if (req.method === 'POST' && path === '/api/apply') {
      sendJson(res, 200, await doApply());
    } else if (req.method === 'POST' && path === '/api/deposit') {
      const body = await readBody(req);
      sendJson(res, 200, await doDeposit(body.amount));
    } else {
      sendJson(res, 404, { error: 'Not found.' });
    }
  })().catch((e: unknown) => {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof Error ? e.message : 'Unexpected error.';
    sendJson(res, status, { error: message });
  });
});

async function main() {
  const mintArtifact = getArtifact('confidentialMint');
  const tokenArtifact = getArtifact('payerConfidentialTokenAccount');
  if (!mintArtifact || !tokenArtifact) {
    console.error('❌ Missing artifacts. Run scripts 05 and 08 first.');
    process.exit(1);
  }
  mint = address(mintArtifact);
  token = address(tokenArtifact);
  payer = await loadKeypairSigner();
  keys = await deriveConfidentialKeys(payer, mint);

  server.listen(PORT, HOST, () => {
    console.log(`\n🔐 Confidential Transfer Lab → http://${HOST}:${PORT}   (cluster: ${CLUSTER})`);
    console.log('   Keys stay in this process; the browser only sees chain state and decrypted numbers.\n');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
