/**
 * Drives one full job and one expiry-refund against Algorand TestNet.
 *
 * This is the rehearsal the spec asks for before any mainnet deployment:
 * fund, deliver, accept, release — then a second job that is funded,
 * left unresolved, and refunded after expiry. Everything it prints is a
 * real transaction id that a third party can check.
 *
 *   DEPLOYER_MNEMONIC="word word ..." pnpm --filter @closeout/client e2e
 *
 * The deployer needs ~2 TestNet ALGO. TestNet ALGO is free but the
 * dispensers are captcha-gated, so funding is a manual step:
 * https://bank.testnet.algorand.network/
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

import algosdk, { Algodv2, getApplicationAddress, makeBasicAccountTransactionSigner } from "algosdk";

import {
  APP_MIN_BALANCE_MICROALGOS,
  STATE,
  configure,
  deployEscrow,
  fundJob,
  markAccepted,
  markDelivered,
  readState,
  refund,
  release,
  waitForConfirmation,
  type Party,
} from "../src/index.ts";

const ALGOD = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const AMOUNT = 10_000n; // 0.01 of a 6-decimal asset
const artifact = (name: string) =>
  readFileSync(
    fileURLToPath(
      new URL(`../../closeout-contract/smart_contracts/artifacts/closeout_escrow/${name}`, import.meta.url),
    ),
    "utf8",
  );

function party(account: algosdk.Account): Party {
  return { addr: account.addr.toString(), signer: makeBasicAccountTransactionSigner(account) };
}

async function balance(algod: Algodv2, addr: string): Promise<bigint> {
  return BigInt((await algod.accountInformation(addr).do()).amount);
}

async function assetBalance(algod: Algodv2, addr: string, assetId: bigint): Promise<bigint> {
  const info = await algod.accountInformation(addr).do();
  const held = info.assets?.find((a) => BigInt(a.assetId) === assetId);
  return held ? BigInt(held.amount) : 0n;
}

async function pay(algod: Algodv2, from: algosdk.Account, to: string, amount: number) {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: from.addr.toString(),
    receiver: to,
    amount,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  const { txid } = await algod.sendRawTransaction(txn.signTxn(from.sk)).do();
  await waitForConfirmation(algod, txid);
  return txid;
}

async function main() {
  const mnemonic = process.env.DEPLOYER_MNEMONIC;
  if (!mnemonic) throw new Error("Set DEPLOYER_MNEMONIC to a funded TestNet account");

  const algod = new Algodv2("", ALGOD, "");
  const deployer = algosdk.mnemonicToSecretKey(mnemonic);
  const buyer = party(deployer);

  const funds = await balance(algod, buyer.addr);
  console.log(`deployer ${buyer.addr}  ${Number(funds) / 1e6} ALGO`);
  if (funds < 2_000_000n) {
    throw new Error(
      `Needs ~2 ALGO, has ${Number(funds) / 1e6}. TestNet ALGO is free: https://bank.testnet.algorand.network/`,
    );
  }

  // A stand-in for USDC. Creating our own asset keeps the rehearsal
  // self-contained: the deployer holds the whole supply and can fund a
  // provider without needing anyone to hand out TestNet USDC.
  const create = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
    sender: buyer.addr,
    total: 1_000_000_000n,
    decimals: 6,
    defaultFrozen: false,
    unitName: "tUSDC",
    assetName: "Closeout Test USDC",
    manager: buyer.addr,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  const created = await algod.sendRawTransaction(create.signTxn(deployer.sk)).do();
  const assetId = BigInt((await waitForConfirmation(algod, created.txid)).assetIndex ?? 0n);
  console.log(`asset ${assetId} created  ${created.txid}`);

  // The provider is a fresh account: it needs ALGO for its own minimum
  // balance and asset opt-in, and must opt in before it can be paid.
  const providerAccount = algosdk.generateAccount();
  const provider = party(providerAccount);
  await pay(algod, deployer, provider.addr, 300_000);
  const optIn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: provider.addr,
    receiver: provider.addr,
    amount: 0n,
    assetIndex: assetId,
    suggestedParams: await algod.getTransactionParams().do(),
  });
  const optInSent = await algod.sendRawTransaction(optIn.signTxn(providerAccount.sk)).do();
  await waitForConfirmation(algod, optInSent.txid);
  console.log(`provider ${provider.addr} opted in  ${optInSent.txid}`);

  const results: Record<string, string | string[]> = {
    assetCreate: created.txid,
    providerOptIn: optInSent.txid,
  };

  // ---- Job 1: fund -> deliver -> accept -> release ----
  const status = await algod.status().do();
  const appId = await runJob(algod, deployer, buyer, provider, assetId, {
    expiresAtRound: BigInt(status.lastRound) + 1_000n,
    results,
    prefix: "released",
  });

  const releasedTo = await assetBalance(algod, provider.addr, assetId);
  console.log(`provider holds ${releasedTo} units (expected ${AMOUNT})`);
  if (releasedTo !== AMOUNT) throw new Error(`Release moved ${releasedTo}, expected ${AMOUNT}`);
  console.log(`job 1 app ${appId} state ${(await readState(algod, appId)).state}`);

  // ---- Job 2: fund, leave unresolved, refund after expiry ----
  const status2 = await algod.status().do();
  const expiry = BigInt(status2.lastRound) + 3n;
  const app2 = await deployAndFund(algod, deployer, buyer, provider.addr, assetId, expiry, results, "refund");

  console.log(`waiting for round ${expiry} before refunding...`);
  await algod.statusAfterBlock(expiry + 1n).do();

  const buyerBefore = await assetBalance(algod, buyer.addr, assetId);
  results.refund = await refund(algod, app2, buyer, { assetId });
  const buyerAfter = await assetBalance(algod, buyer.addr, assetId);
  if (buyerAfter - buyerBefore !== AMOUNT) {
    throw new Error(`Refund returned ${buyerAfter - buyerBefore}, expected ${AMOUNT}`);
  }
  console.log(`job 2 app ${app2} refunded  ${results.refund}`);

  console.log("\n--- transaction ids ---");
  console.log(JSON.stringify({ appId: appId.toString(), app2: app2.toString(), ...results }, null, 2));
}

async function deployAndFund(
  algod: Algodv2,
  deployer: algosdk.Account,
  buyer: Party,
  providerAddr: string,
  assetId: bigint,
  expiresAtRound: bigint,
  results: Record<string, string | string[]>,
  prefix: string,
): Promise<bigint> {
  const appId = await deployEscrow(algod, deployer, {
    approval: artifact("CloseoutEscrow.approval.teal"),
    clear: artifact("CloseoutEscrow.clear.teal"),
  });
  const appAddress = getApplicationAddress(appId).toString();
  results[`${prefix}Deploy`] = appId.toString();

  // The application account holds an ASA, so it needs its own minimum
  // balance before the opt-in inner transaction can succeed.
  await pay(algod, deployer, appAddress, APP_MIN_BALANCE_MICROALGOS + 100_000);

  results[`${prefix}Configure`] = await configure(algod, appId, buyer, {
    provider: providerAddr,
    assetId,
    amount: AMOUNT,
    expiresAtRound,
  });
  results[`${prefix}Fund`] = await fundJob(algod, appId, buyer, { appAddress, assetId, amount: AMOUNT });
  return appId;
}

async function runJob(
  algod: Algodv2,
  deployer: algosdk.Account,
  buyer: Party,
  provider: Party,
  assetId: bigint,
  opts: { expiresAtRound: bigint; results: Record<string, string | string[]>; prefix: string },
): Promise<bigint> {
  const { results, prefix } = opts;
  const appId = await deployAndFund(
    algod,
    deployer,
    buyer,
    provider.addr,
    assetId,
    opts.expiresAtRound,
    results,
    prefix,
  );

  results[`${prefix}Deliver`] = await markDelivered(algod, appId, provider);

  // The intent hash is the commitment the payout is bound to. A real
  // client hashes the canonical SettlementIntent; the rehearsal only
  // needs it to be the same 32 bytes at accept and at release.
  const intentHash = createHash("sha256").update(randomBytes(32)).digest();
  results[`${prefix}Accept`] = await markAccepted(algod, appId, buyer, intentHash);

  const state = await readState(algod, appId);
  if (state.state !== BigInt(STATE.accepted)) throw new Error(`Expected accepted, got ${state.state}`);

  // Submitted by the provider on purpose: proves the rule that either
  // party may release once acceptance is recorded.
  results[`${prefix}Release`] = await release(algod, appId, provider, {
    provider: provider.addr,
    assetId,
    intentHash,
  });
  return appId;
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
