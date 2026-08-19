/**
 * Two agents transacting over one real job, settled on TestNet.
 *
 * The buyer wants an asset control-surface report — who, other than the
 * holder, can move or immobilise a holding. The provider reads it off a
 * node and delivers it. The buyer runs the deterministic verifier it
 * named up front, and settles only if the delivery passes.
 *
 *   DEPLOYER_MNEMONIC="…" pnpm --filter @closeout/demo-agents demo
 *
 * The buyer and the provider are separate accounts holding separate keys,
 * and the provider is paid because the buyer accepted, not because this
 * script says so — the escrow enforces that. Everything printed is a real
 * transaction id.
 */
import { randomBytes } from "node:crypto";

import algosdk, { Algodv2, getApplicationAddress, makeBasicAccountTransactionSigner } from "algosdk";

import {
  accept,
  createJob,
  deriveReceipt,
  fund,
  hashSettlementIntent,
  release,
  submitDelivery,
  type SettlementIntent,
} from "@closeout/core";
import {
  APP_MIN_BALANCE_MICROALGOS,
  configure,
  deployEscrow,
  fundJob,
  markAccepted,
  markDelivered,
  release as releaseOnChain,
  verifyReceiptOnChain,
  waitForConfirmation,
  type Party,
} from "@closeout/client";

import { produceReport } from "./provider.ts";
import { renderFrame } from "./frame.ts";
import { contentHash, taskCommitment, taskRequest, verifyDelivery } from "./task.ts";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ALGOD = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const BUDGET = 25_000n; // 0.025 of a 6-decimal asset, agreed before any work

const artifact = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(
        `../../../packages/closeout-contract/smart_contracts/artifacts/closeout_escrow/${name}`,
        import.meta.url,
      ),
    ),
    "utf8",
  );

const party = (a: algosdk.Account): Party => ({
  addr: a.addr.toString(),
  signer: makeBasicAccountTransactionSigner(a),
});

async function pay(algod: Algodv2, from: algosdk.Account, to: string, amount: number) {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(),
    receiver: to,
    amount,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(from.sk)).do();
  await waitForConfirmation(algod, txid);
}

async function main() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error("Set DEPLOYER_MNEMONIC to a funded TestNet account");

  const algod = new Algodv2("", ALGOD, "");
  const buyerAccount = algosdk.mnemonicToSecretKey(mnemonic);
  const providerAccount = algosdk.generateAccount();
  const buyer = party(buyerAccount);
  const provider = party(providerAccount);

  console.log(`buyer    ${buyer.addr}`);
  console.log(`provider ${provider.addr}\n`);

  // --- The budget asset. Real USDC on MainNet; a stand-in here. ---
  const create = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: buyer.addr,
    total: 1_000_000_000n,
    decimals: 6,
    defaultFrozen: false,
    unitName: "tUSDC",
    assetName: "Closeout Demo USDC",
    manager: buyer.addr,
    freeze: buyer.addr,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  const createdTx = await algod.sendRawTransaction(create.signTxn(buyerAccount.sk)).do();
  const assetId = BigInt((await waitForConfirmation(algod, createdTx.txid)).assetIndex ?? 0n);
  console.log(`[budget] asset ${assetId} created`);

  await pay(algod, buyerAccount, provider.addr, 400_000);
  const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: provider.addr,
    receiver: provider.addr,
    amount: 0n,
    assetIndex: assetId,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  await waitForConfirmation(algod, (await algod.sendRawTransaction(optIn.signTxn(providerAccount.sk)).do()).txid);

  // --- 1. The buyer states the job, before any work exists. ---
  // The subject is the budget asset itself, which has a freeze address
  // and a manager: a report on it has a non-trivial answer.
  const request = taskRequest(Number(assetId));
  const salt = randomBytes(16).toString("hex");
  const jobId = `demo_${Date.now()}`;
  const status = await algod.status().do();

  let job = createJob({
    id: jobId,
    buyer: buyer.addr,
    provider: provider.addr,
    assetId: Number(assetId),
    amount: BUDGET.toString(),
    expiresAtRound: Number(status.lastRound) + 1_000,
    deliveryMode: "deterministic_verify",
    taskCommitment: taskCommitment(request, salt),
  });
  console.log(`[buyer] job ${jobId}: control surface of asset ${assetId}, budget ${BUDGET} units`);

  // --- 2. Escrow deployed and funded. ---
  const appId = await deployEscrow(algod, buyerAccount, {
    approval: artifact("CloseoutEscrow.approval.teal"),
    clear: artifact("CloseoutEscrow.clear.teal"),
  });
  const appAddress = getApplicationAddress(appId).toString();
  await pay(algod, buyerAccount, appAddress, APP_MIN_BALANCE_MICROALGOS + 100_000);
  await configure(algod, appId, buyer, {
    provider: provider.addr,
    assetId,
    amount: BUDGET,
    expiresAtRound: BigInt(job.expiresAtRound),
  });
  const fundTxIds = await fundJob(algod, appId, buyer, { appAddress, assetId, amount: BUDGET });
  job = fund(job, buyer.addr, fundTxIds[0]);
  console.log(`[buyer] escrow ${appId} funded  ${fundTxIds[0]}`);

  // --- 3. The provider does the work and delivers a commitment. ---
  const report = await produceReport(algod, request);
  const deliveryHash = contentHash(report);
  const deliverTx = await markDelivered(algod, appId, provider);
  job = submitDelivery(job, provider.addr, {
    contentHash: deliveryHash,
    submittedAt: new Date().toISOString(),
    // Where the artifact actually lives stays private: the chain and the
    // receipt carry the commitment, never the location.
    uri: `https://provider.example/deliveries/${jobId}`,
  });
  console.log(`[provider] delivered ${deliveryHash.slice(0, 16)}…  ${deliverTx}`);
  for (const finding of report.findings) console.log(`           • ${finding}`);

  // --- 4. The buyer verifies before accepting. ---
  const verdict = verifyDelivery(request, report);
  if (!verdict.ok) {
    console.error(`[buyer] REJECTED: ${verdict.reasons.join("; ")}`);
    console.error("        Funds stay in escrow and refund after expiry. Nothing is paid.");
    process.exit(1);
  }
  console.log("[buyer] delivery passes the verifier named in the job");

  const intent: SettlementIntent = {
    schema: "closeout-settlement-intent/v1",
    jobId,
    buyer: buyer.addr,
    provider: provider.addr,
    assetId: Number(assetId),
    amount: BUDGET.toString(),
    nonce: randomBytes(16).toString("hex"),
    expiresAtRound: job.expiresAtRound,
  };
  const intentHash = Buffer.from(hashSettlementIntent(intent), "hex");
  const acceptTx = await markAccepted(algod, appId, buyer, new Uint8Array(intentHash));
  job = accept(job, buyer.addr, intent);
  console.log(`[buyer] accepted  ${acceptTx}`);

  // --- 5. The forgery, attempted first, so the payout is not the only
  // thing this demo has ever been seen to do.
  //
  // Same escrow, same round, same two parties, same accepted delivery.
  // One field of the settlement intent differs: the provider bills ten
  // times the budget. The escrow compares the hash against the intent the
  // buyer actually accepted and declines. Nothing here is simulated — if
  // the chain were to allow this, the demo aborts rather than print a
  // picture that is not true.
  const forgedIntent: SettlementIntent = { ...intent, amount: (BUDGET * 10n).toString() };
  const forgedHash = Buffer.from(hashSettlementIntent(forgedIntent), "hex");
  let refusal: string;
  try {
    await releaseOnChain(algod, appId, provider, {
      provider: provider.addr,
      assetId,
      intentHash: new Uint8Array(forgedHash),
    });
    console.error("\n[demo] ABORT: the escrow paid out against an intent the buyer never accepted.");
    console.error("       That is the rule this project exists to enforce. Stopping.");
    process.exit(1);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
    console.log(`[provider] release against a forged intent REFUSED by the escrow`);
  }

  // --- 6. The honest release. The provider collects; the buyer is not involved. ---
  const releaseTx = await releaseOnChain(algod, appId, provider, {
    provider: provider.addr,
    assetId,
    intentHash: new Uint8Array(intentHash),
  });
  job = release(job, intent, Number((await algod.status().do()).lastRound), releaseTx);
  console.log(`[provider] released to self on the buyer's acceptance  ${releaseTx}`);

  // --- 7. The receipt, checked against the chain by neither party. ---
  const receipt = deriveReceipt(job);
  const verification = await verifyReceiptOnChain(algod, appId, receipt);
  console.log(`\n[anyone] receipt verifies against the chain: ${verification.ok}`);
  for (const check of verification.checks) console.log(`         ${check.ok ? "✓" : "✗"} ${check.name}`);

  const held = (await algod.accountInformation(provider.addr).do()).assets?.find(
    (a) => BigInt(a.assetId) === assetId,
  );
  console.log(`\nprovider holds ${held?.amount ?? 0} units (budget was ${BUDGET})`);

  // The one shot: both outcomes came out of this same run, minutes apart,
  // off the same escrow.
  console.log(
    "\n" +
      renderFrame(
        `Escrow ${appId} — one accepted delivery, two attempted settlements`,
        [
          { label: "intent amount", refused: `${forgedIntent.amount}  ← one field`, settled: intent.amount },
          { label: "parties, asset, nonce", refused: "identical", settled: "identical" },
          { label: "escrow's answer", refused: "declined", settled: releaseTx },
          { label: "provider received", refused: "0 units", settled: `${held?.amount ?? 0} units` },
          { label: "", refused: "", settled: "" },
          { label: "verdict", refused: "REFUSED", settled: "SETTLED" },
        ],
        [
          `Refusal reported by the node: ${refusal.split("\n")[0].slice(0, 120)}`,
          "The buyer was not asked twice. Acceptance authorised one settlement,",
          "and the escrow paid that one and no other.",
        ],
      ),
  );
  console.log(`\n${JSON.stringify({ appId: appId.toString(), receipt }, null, 2)}`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
