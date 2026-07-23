import assert from "node:assert/strict";
import test from "node:test";
import {
  TransitionError,
  accept,
  createJob,
  fund,
  hashSettlementIntent,
  release,
  refund,
  submitDelivery,
  type SettlementIntent,
} from "../src/index.js";

const baseJob = () =>
  createJob({
    id: "job_01",
    buyer: "BUYER",
    provider: "PROVIDER",
    assetId: 31566704,
    amount: "100000",
    expiresAtRound: 500,
    deliveryMode: "buyer_accepts",
  });

const intent = (overrides: Partial<SettlementIntent> = {}): SettlementIntent => ({
  schema: "closeout-settlement-intent/v1",
  jobId: "job_01",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "100000",
  nonce: "nonce_01",
  expiresAtRound: 500,
  ...overrides,
});

function deliveredJob() {
  return submitDelivery(
    fund(baseJob(), "BUYER", "fund_tx"),
    "PROVIDER",
    { contentHash: "a".repeat(64), submittedAt: "2026-07-23T22:00:00.000Z" },
  );
}

test("settles an accepted delivery exactly once", () => {
  const accepted = accept(deliveredJob(), "BUYER", intent());
  const released = release(accepted, intent(), 499, "release_tx");

  assert.equal(released.state, "released");
  assert.equal(released.settlementTxId, "release_tx");
  assert.throws(() => release(released, intent(), 499, "again"), TransitionError);
});

test("rejects every material settlement-intent mismatch", () => {
  const accepted = accept(deliveredJob(), "BUYER", intent());
  const changes: Partial<SettlementIntent>[] = [
    { provider: "ATTACKER" },
    { amount: "100001" },
    { assetId: 1 },
    { nonce: "nonce_02" },
    { expiresAtRound: 501 },
  ];

  for (const change of changes) {
    assert.throws(() => release(accepted, intent(change), 499, "release_tx"), TransitionError);
  }
});

test("hash is stable for the same settlement intent", () => {
  assert.equal(hashSettlementIntent(intent()), hashSettlementIntent(intent()));
  assert.notEqual(hashSettlementIntent(intent()), hashSettlementIntent(intent({ nonce: "different" })));
});

test("an uncertain or unaccepted job refunds only after expiry", () => {
  const delivered = deliveredJob();
  assert.throws(() => refund(delivered, "BUYER", 500, "refund_tx"), TransitionError);

  const refunded = refund(delivered, "BUYER", 501, "refund_tx");
  assert.equal(refunded.state, "refunded");
  assert.throws(() => release(refunded, intent(), 501, "release_tx"), TransitionError);
});

test("only the named parties may fund, deliver, or accept", () => {
  const draft = baseJob();
  assert.throws(() => fund(draft, "OTHER", "fund_tx"), TransitionError);
  const funded = fund(draft, "BUYER", "fund_tx");
  assert.throws(
    () => submitDelivery(funded, "OTHER", { contentHash: "a".repeat(64), submittedAt: "now" }),
    TransitionError,
  );
  assert.throws(() => accept(deliveredJob(), "OTHER", intent()), TransitionError);
});
