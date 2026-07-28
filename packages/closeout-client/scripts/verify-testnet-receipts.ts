/**
 * Verifies receipts against the real TestNet settlements in
 * ../../TESTNET-RUN.md, using nothing but a public node.
 *
 * Run it with `npx tsx scripts/verify-live.ts`. It checks an honest
 * receipt for each path, and three forgeries: an inflated amount, a
 * substituted settlement intent, and a released receipt pointed at the
 * refunded escrow. No Closeout API is involved anywhere — that is the
 * whole point.
 */
import { Algodv2 } from "algosdk";
import { verifyReceiptOnChain } from "../src/verify.ts";
import type { SettlementReceipt } from "@closeout/core";

const algod = new Algodv2("", "https://testnet-api.algonode.cloud", "");

// The released job from TESTNET-RUN.md. Intent hash read back off chain,
// converted to the hex form a receipt carries.
const app = await algod.getApplicationByID(768201279n).do();
const onChainIntent = app.params!.globalState!.find(
  (e: any) => Buffer.from(e.key).toString("utf8") === "acceptedIntent",
)!;
const intentHex = Buffer.from(onChainIntent.value.bytes).toString("hex");

const good: SettlementReceipt = {
  schema: "closeout-settlement-receipt/v1",
  jobId: "testnet_job_1", jobHash: "0".repeat(64), state: "released",
  buyer: "BUYER", provider: "XBUWT2ES4MU56BSJNVTNAOGHZXWOS54ZYK246HPJ6ZQ7GGVCR47RIEYLCM",
  assetId: 768201264, amount: "10000", taskCommitment: "b".repeat(64),
  settlementIntentHash: intentHex,
  fundingTxId: "T5HSXOFEIHLXLTGGRFOZAKUR6IJ6Q3XVVMXJTT6T52VIMFLL7L2Q",
  settlementTxId: "F5HOR3E7KJUTGWT3NWW2XOPLH3HG75QMTA4WCXYQZ6T7R2N4ENKA",
  issuedAt: new Date().toISOString(),
};

console.log("honest released receipt :", (await verifyReceiptOnChain(algod, 768201279n, good)).ok);

const inflated = { ...good, amount: "5000000" };
const r2 = await verifyReceiptOnChain(algod, 768201279n, inflated);
console.log("inflated amount         :", r2.ok, "->", r2.checks.find((c) => !c.ok)?.detail);

const forged = { ...good, settlementIntentHash: "f".repeat(64) };
const r3 = await verifyReceiptOnChain(algod, 768201279n, forged);
console.log("forged intent           :", r3.ok, "->", r3.checks.find((c) => !c.ok)?.name);

const refundReceipt = { ...good, state: "refunded" as const, settlementIntentHash: undefined,
  settlementTxId: "WH73UOLPBNH3DDNR5BJAS3ESTKMY57YJZUMIIG35GCRMDNFT7Q6Q" };
console.log("honest refunded receipt :", (await verifyReceiptOnChain(algod, 768201307n, refundReceipt)).ok);

const wrongApp = await verifyReceiptOnChain(algod, 768201307n, good);
console.log("released receipt vs refunded escrow:", wrongApp.ok, "->", wrongApp.checks.find((c) => !c.ok)?.detail);
