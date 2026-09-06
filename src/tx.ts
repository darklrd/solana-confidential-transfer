// Shared transaction helper: build -> sign -> send -> confirm.
// Every numbered script uses this instead of repeating the kit pipeline.
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  createTransactionPlanExecutor,
  createTransactionPlanner,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type InstructionPlan,
  type TransactionSigner,
} from '@solana/kit';
import { getRpc, getRpcSubscriptions } from './config';

/**
 * Sign `instructions` into one atomic transaction paid by `feePayer`,
 * send it, wait for confirmation, and return the signature.
 */
export async function sendInstructions(
  feePayer: TransactionSigner,
  instructions: Instruction[],
): Promise<string> {
  const rpc = getRpc();
  const rpcSubscriptions = getRpcSubscriptions();

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const txMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(txMessage);
  // Signing erases the specific lifetime brand; re-narrow to blockhash
  // lifetime so the (blockhash-based) confirmer accepts it.
  assertIsTransactionWithBlockhashLifetime(signedTx);
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signedTx, { commitment: 'confirmed' });
  return getSignatureFromTransaction(signedTx);
}

/**
 * Execute an InstructionPlan (the token-2022 confidential helpers return
 * these): the planner packs instructions into as few transactions as fit,
 * respecting plan structure — e.g. a non-divisible sequence stays atomic in
 * one transaction. Returns the signature of every confirmed transaction.
 */
export async function executeInstructionPlan(
  feePayer: TransactionSigner,
  plan: InstructionPlan,
): Promise<string[]> {
  const rpc = getRpc();
  const rpcSubscriptions = getRpcSubscriptions();
  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      pipe(createTransactionMessage({ version: 0 }), (m) =>
        setTransactionMessageFeePayerSigner(feePayer, m),
      ),
  });

  const signatures: string[] = [];
  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_context, message) => {
      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
      const signedTx = await signTransactionMessageWithSigners(
        setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, message),
      );
      assertIsTransactionWithBlockhashLifetime(signedTx);
      await sendAndConfirm(signedTx, { commitment: 'confirmed' });
      signatures.push(getSignatureFromTransaction(signedTx));
      return signedTx;
    },
  });

  await executor(await planner(plan));
  return signatures;
}
