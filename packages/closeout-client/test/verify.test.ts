import assert from "node:assert/strict";
import test from "node:test";

import type { Algodv2 } from "algosdk";
import type { SettlementReceipt } from "@closeout/core";

import { verifyReceiptOnChain } from "../src/verify.ts";

const INTENT_HEX = "a".repeat(64);
const INTENT_B64 = Buffer.from(INTENT_HEX, "hex").toString("base64");

/**
 * A node that answers with one application's global state.
 *
 * algosdk v3 hands back keys and byte values already decoded as
 * Uint8Array, not as the base64 strings the raw REST API returns — a stub
 * that passes base64 strings reads as empty state and every check fails
 * for the wrong reason.
 */
function nodeReturning(globalState: ReturnType<typeof entry>[]) {
  return {
    getApplicationByID: () => ({
      do: async () => ({ params: { globalState } }),
    }),
  } as unknown as Algodv2;
}

function entry(key: string, value: { type: number; uint?: number; bytes?: string }) {
  return {
    key: new Uint8Array(Buffer.from(key, "utf8")),
    value: {
      type: value.type,
      uint: value.uint,
      bytes: value.bytes ? new Uint8Array(Buffer.from(value.bytes, "base64")) : undefined,
    },
  };
}

const releasedState = [
  entry("state", { type: 2, uint: 5 }),
  entry("amount", { type: 2, uint: 10_000 }),
  entry("acceptedIntent", { type: 1, bytes: INTENT_B64 }),
];

const receipt = (overrides: Partial<SettlementReceipt> = {}): SettlementReceipt => ({
  schema: "closeout-settlement-receipt/v1",
  jobId: "job_01",
  jobHash: "c".repeat(64),
  state: "released",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "10000",
  taskCommitment: "b".repeat(64),
  settlementIntentHash: INTENT_HEX,
  fundingTxId: "fund_tx",
  settlementTxId: "release_tx",
  issuedAt: "2026-07-27T00:00:00.000Z",
  ...overrides,
});

test("a receipt matching the chain verifies", async () => {
  const result = await verifyReceiptOnChain(nodeReturning(releasedState), 1n, receipt());
  assert.equal(result.ok, true, JSON.stringify(result.checks));
});

test("a receipt claiming an amount the chain does not show fails", async () => {
  // The case that matters: an issuer inflating what was settled.
  const result = await verifyReceiptOnChain(nodeReturning(releasedState), 1n, receipt({ amount: "999999" }));
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === "amount matches")?.ok, false);
});

test("a receipt naming an intent the buyer never accepted fails", async () => {
  // Without this check, a receipt could bind a real payment to a
  // different agreement than the one the buyer signed.
  const result = await verifyReceiptOnChain(
    nodeReturning(releasedState),
    1n,
    receipt({ settlementIntentHash: "d".repeat(64) }),
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((c) => c.name === "settlement intent matches the accepted one")?.ok,
    false,
  );
});

test("a receipt claiming release against a refunded escrow fails", async () => {
  const refundedState = [entry("state", { type: 2, uint: 6 }), entry("amount", { type: 2, uint: 10_000 })];
  const result = await verifyReceiptOnChain(nodeReturning(refundedState), 1n, receipt());
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === "escrow is released")?.ok, false);
});

test("a refunded receipt must not claim an acceptance", async () => {
  const refundedState = [entry("state", { type: 2, uint: 6 }), entry("amount", { type: 2, uint: 10_000 })];
  const good = await verifyReceiptOnChain(
    nodeReturning(refundedState),
    1n,
    receipt({ state: "refunded", settlementIntentHash: undefined, settlementTxId: "refund_tx" }),
  );
  assert.equal(good.ok, true, JSON.stringify(good.checks));

  const bad = await verifyReceiptOnChain(
    nodeReturning(refundedState),
    1n,
    receipt({ state: "refunded", settlementTxId: "refund_tx" }),
  );
  assert.equal(bad.ok, false);
});

test("an unreachable application fails closed rather than passing", async () => {
  const broken = {
    getApplicationByID: () => ({
      do: async () => {
        throw new Error("application does not exist");
      },
    }),
  } as unknown as Algodv2;

  const result = await verifyReceiptOnChain(broken, 1n, receipt());
  assert.equal(result.ok, false);
  assert.equal(result.checks[0].ok, false);
});
