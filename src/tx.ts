// Shared transaction helper: build -> sign -> send -> confirm.
// Every numbered script uses this instead of repeating the kit pipeline.
import {
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
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
