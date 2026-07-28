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
  deriveReceipt,
  verifyReceipt,
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
    taskCommitment: "b".repeat(64),
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
    {
      contentHash: "a".repeat(64),
      submittedAt: "2026-07-23T22:00:00.000Z",
      // Private: a receipt must never carry this.
      uri: "https://private.example/deliveries/secret-artifact",
    },
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

test("an accepted job is no longer refundable, however long the buyer waits", () => {
  // Acceptance is one-way, and the off-chain machine must agree with the
  // contract: if this permitted a refund the contract rejects, the API
  // would report a settled outcome the chain never performed — which is
  // the whole claim this product makes.
  const accepted = accept(deliveredJob(), "BUYER", intent());
  assert.throws(() => refund(accepted, "BUYER", 100_000, "refund_tx"), TransitionError);
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

test("a settled job derives a receipt that re-derives to the same hashes", () => {
  // The receipt is only worth anything if it can be recomputed from the
  // job record and checked — otherwise it is just our word in a nicer
  // shape.
  const accepted = accept(deliveredJob(), "BUYER", intent());
  const released = release(accepted, intent(), 100, "release_tx");
  const receipt = deriveReceipt(released);

  assert.equal(receipt.schema, "closeout-settlement-receipt/v1");
  assert.equal(receipt.state, "released");
  assert.equal(receipt.settlementTxId, "release_tx");
  assert.equal(receipt.settlementIntentHash, released.settlementIntentHash);
  assert.equal(receipt.jobHash, deriveReceipt(released).jobHash);
  assert.equal(verifyReceipt(receipt, released), true);
});

test("a receipt carries commitments, never raw task or delivery content", () => {
  const accepted = accept(deliveredJob(), "BUYER", intent());
  const released = release(accepted, intent(), 100, "release_tx");
  const receipt = deriveReceipt(released);
  const serialized = JSON.stringify(receipt);

  // deliveredJob() submits a delivery with a private uri.
  assert.ok(released.delivery?.uri, "fixture must carry a private uri to be meaningful");
  assert.ok(!serialized.includes(released.delivery.uri), "receipt leaked the delivery uri");
  assert.equal(receipt.deliveryCommitment, released.delivery.contentHash);
});

test("an unsettled job has no receipt to issue", () => {
  assert.throws(() => deriveReceipt(deliveredJob()), TransitionError);
});

test("a refunded job derives a receipt naming the refund", () => {
  const funded = fund(baseJob(), "BUYER", "fund_tx");
  const refunded = refund(funded, "BUYER", 501, "refund_tx");
  const receipt = deriveReceipt(refunded);

  assert.equal(receipt.state, "refunded");
  assert.equal(receipt.settlementTxId, "refund_tx");
  assert.equal(receipt.settlementIntentHash, undefined);
});

test("a receipt does not verify against a different job", () => {
  const accepted = accept(deliveredJob(), "BUYER", intent());
  const released = release(accepted, intent(), 100, "release_tx");
  const receipt = deriveReceipt(released);

  assert.equal(verifyReceipt(receipt, { ...released, amount: "999999" }), false);
});

test("a job cannot be created without a task commitment", () => {
  // Without it a receipt cannot name what was agreed, and the settlement
  // record proves a payment with no subject.
  assert.throws(() => createJob({ ...baseJob(), taskCommitment: "" }), TransitionError);
});
