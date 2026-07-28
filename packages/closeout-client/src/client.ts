import {
  Algodv2,
  AtomicTransactionComposer,
  makeApplicationCreateTxnFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  OnApplicationComplete,
  type Account,
  type SuggestedParams,
  type TransactionSigner,
  type TransactionWithSigner,
} from "algosdk";

import { APP_MIN_BALANCE_MICROALGOS, CLOSEOUT_METHODS, GLOBAL_SCHEMA } from "./methods.ts";

export interface Party {
  addr: string;
  signer: TransactionSigner;
}

/**
 * Fee paid on calls that submit an inner transaction.
 *
 * `configure` and `release` build their inner transfer with `fee: 0`, so
 * the outer call has to cover both. Paying only the minimum leaves the
 * inner transaction underfunded and the whole call fails on chain with a
 * fee error that says nothing about which transaction was short.
 */
export const INNER_FEE_COVER = 2_000;

async function params(algod: Algodv2, fee?: number): Promise<SuggestedParams> {
  const sp = await algod.getTransactionParams().do();
  if (fee !== undefined) {
    // flatFee, or algosdk multiplies the fee by the encoded size.
    return { ...sp, flatFee: true, fee: BigInt(fee) };
  }
  return sp;
}

/** Compiles the TEAL pair and creates the application. Returns its id. */
export async function deployEscrow(
  algod: Algodv2,
  creator: Account,
  programs: { approval: string; clear: string },
): Promise<bigint> {
  const compile = async (teal: string) =>
    new Uint8Array(Buffer.from((await algod.compile(teal).do()).result, "base64"));

  const txn = makeApplicationCreateTxnFromObject({
    sender: creator.addr.toString(),
    approvalProgram: await compile(programs.approval),
    clearProgram: await compile(programs.clear),
    numGlobalInts: GLOBAL_SCHEMA.numUint,
    numGlobalByteSlices: GLOBAL_SCHEMA.numByteSlice,
    numLocalInts: 0,
    numLocalByteSlices: 0,
    onComplete: OnApplicationComplete.NoOpOC,
    suggestedParams: await params(algod),
  });

  const signed = txn.signTxn(creator.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  const result = await waitForConfirmation(algod, txid);
  const appId = result.applicationIndex;
  if (appId === undefined) throw new Error("Application creation returned no application index");
  return BigInt(appId);
}

export interface Confirmation {
  poolError?: string;
  confirmedRound?: bigint;
  applicationIndex?: bigint;
  assetIndex?: bigint;
}

/** Waits for a transaction, surfacing the pool error rather than a timeout. */
export async function waitForConfirmation(
  algod: Algodv2,
  txid: string,
  rounds = 6,
): Promise<Confirmation> {
  let last = (await algod.status().do()).lastRound;
  for (let i = 0; i < rounds; i++) {
    const pending = await algod.pendingTransactionInformation(txid).do();
    if (pending.poolError) throw new Error(`Rejected: ${pending.poolError}`);
    if (pending.confirmedRound) return pending;
    last = last + 1n;
    await algod.statusAfterBlock(last).do();
  }
  throw new Error(`Transaction ${txid} not confirmed after ${rounds} rounds`);
}

/**
 * Stores the job terms and opts the application into the asset.
 *
 * The asset has to be passed as a foreign asset: the inner opt-in
 * references it, and an unnamed resource is not available to it.
 */
export async function configure(
  algod: Algodv2,
  appId: bigint,
  buyer: Party,
  terms: { provider: string; assetId: bigint; amount: bigint; expiresAtRound: bigint },
): Promise<string> {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: CLOSEOUT_METHODS.configure,
    sender: buyer.addr,
    signer: buyer.signer,
    methodArgs: [buyer.addr, terms.provider, terms.assetId, terms.amount, terms.expiresAtRound],
    appForeignAssets: [terms.assetId],
    suggestedParams: await params(algod, INNER_FEE_COVER),
  });
  return (await atc.execute(algod, 6)).txIDs[0];
}

/**
 * The funding group: an asset transfer into the application account,
 * immediately followed by `fund`. The contract reads the transfer as a
 * grouped transaction, so the two must travel together and in this order.
 */
export async function fundJob(
  algod: Algodv2,
  appId: bigint,
  buyer: Party,
  job: { appAddress: string; assetId: bigint; amount: bigint },
): Promise<string[]> {
  const sp = await params(algod);
  const transfer: TransactionWithSigner = {
    txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: buyer.addr,
      receiver: job.appAddress,
      amount: job.amount,
      assetIndex: job.assetId,
      suggestedParams: sp,
    }),
    signer: buyer.signer,
  };

  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: CLOSEOUT_METHODS.fund,
    sender: buyer.addr,
    signer: buyer.signer,
    methodArgs: [transfer],
    appForeignAssets: [job.assetId],
    suggestedParams: sp,
  });
  return (await atc.execute(algod, 6)).txIDs;
}

/** Provider records that a delivery was submitted off-chain. */
export async function markDelivered(algod: Algodv2, appId: bigint, provider: Party): Promise<string> {
  return callNoArgs(algod, appId, provider, CLOSEOUT_METHODS.markDelivered);
}

/** Buyer accepts, committing to the settlement intent that authorizes payment. */
export async function markAccepted(
  algod: Algodv2,
  appId: bigint,
  buyer: Party,
  intentHash: Uint8Array,
): Promise<string> {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: CLOSEOUT_METHODS.markAccepted,
    sender: buyer.addr,
    signer: buyer.signer,
    methodArgs: [intentHash],
    suggestedParams: await params(algod),
  });
  return (await atc.execute(algod, 6)).txIDs[0];
}

/**
 * Releases the funded amount to the provider. Either party may submit it,
 * and it must carry the same intent hash the buyer accepted.
 */
export async function release(
  algod: Algodv2,
  appId: bigint,
  submitter: Party,
  job: { provider: string; assetId: bigint; intentHash: Uint8Array },
): Promise<string> {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: CLOSEOUT_METHODS.release,
    sender: submitter.addr,
    signer: submitter.signer,
    methodArgs: [job.intentHash],
    appAccounts: [job.provider],
    appForeignAssets: [job.assetId],
    suggestedParams: await params(algod, INNER_FEE_COVER),
  });
  return (await atc.execute(algod, 6)).txIDs[0];
}

/** Returns the funds to the buyer, once an unresolved job has expired. */
export async function refund(
  algod: Algodv2,
  appId: bigint,
  buyer: Party,
  job: { assetId: bigint },
): Promise<string> {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method: CLOSEOUT_METHODS.refund,
    sender: buyer.addr,
    signer: buyer.signer,
    methodArgs: [],
    appAccounts: [buyer.addr],
    appForeignAssets: [job.assetId],
    suggestedParams: await params(algod, INNER_FEE_COVER),
  });
  return (await atc.execute(algod, 6)).txIDs[0];
}

async function callNoArgs(
  algod: Algodv2,
  appId: bigint,
  party: Party,
  method: (typeof CLOSEOUT_METHODS)[keyof typeof CLOSEOUT_METHODS],
): Promise<string> {
  const atc = new AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method,
    sender: party.addr,
    signer: party.signer,
    methodArgs: [],
    suggestedParams: await params(algod),
  });
  return (await atc.execute(algod, 6)).txIDs[0];
}

/** Reads the escrow's global state as plain values. */
export async function readState(algod: Algodv2, appId: bigint): Promise<Record<string, bigint | string>> {
  const app = await algod.getApplicationByID(appId).do();
  const out: Record<string, bigint | string> = {};
  for (const entry of app.params?.globalState ?? []) {
    const key = Buffer.from(entry.key).toString("utf8");
    out[key] =
      entry.value.type === 2 ? BigInt(entry.value.uint) : Buffer.from(entry.value.bytes).toString("base64");
  }
  return out;
}
