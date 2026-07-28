import assert from "node:assert/strict";
import test from "node:test";
import { createCloseoutApp } from "../src/app.js";

const job = {
  id: "job_01",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "100000",
  expiresAtRound: 500,
  deliveryMode: "buyer_accepts",
  taskCommitment: "b".repeat(64),
};

const intent = {
  jobId: "job_01",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "100000",
  nonce: "intent_01",
  expiresAtRound: 500,
};

async function post(app: ReturnType<typeof createCloseoutApp>, path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("creates, funds, delivers, accepts, and releases a job", async () => {
  const app = createCloseoutApp();
  assert.equal((await post(app, "/jobs", job)).status, 201);
  assert.equal((await post(app, "/jobs/job_01/funding", { actor: "BUYER", fundingTxId: "fund_tx" })).status, 200);
  assert.equal((await post(app, "/jobs/job_01/deliveries", {
    actor: "PROVIDER", contentHash: "a".repeat(64), submittedAt: "2026-07-23T00:00:00.000Z",
  })).status, 200);
  assert.equal((await post(app, "/jobs/job_01/accept", { actor: "BUYER", intent })).status, 200);

  const release = await post(app, "/jobs/job_01/release", { intent, currentRound: 499, settlementTxId: "release_tx" });
  assert.equal(release.status, 200);
  assert.equal((await release.json() as { job: { state: string } }).job.state, "released");
});

test("does not release a changed payment recipient", async () => {
  const app = createCloseoutApp();
  await post(app, "/jobs", job);
  await post(app, "/jobs/job_01/funding", { actor: "BUYER", fundingTxId: "fund_tx" });
  await post(app, "/jobs/job_01/deliveries", { actor: "PROVIDER", contentHash: "a".repeat(64), submittedAt: "now" });
  await post(app, "/jobs/job_01/accept", { actor: "BUYER", intent });

  const release = await post(app, "/jobs/job_01/release", {
    intent: { ...intent, provider: "ATTACKER" }, currentRound: 499, settlementTxId: "release_tx",
  });
  assert.equal(release.status, 409);
});

test("a settled job exposes a receipt, and an unsettled one does not", async () => {
  const app = createCloseoutApp();
  assert.equal((await post(app, "/jobs", job)).status, 201);

  // Nothing to certify before settlement.
  assert.equal((await app.request("/receipts/job_01")).status, 409);

  assert.equal((await post(app, "/jobs/job_01/funding", { actor: "BUYER", fundingTxId: "fund_tx" })).status, 200);
  assert.equal((await post(app, "/jobs/job_01/deliveries", {
    actor: "PROVIDER",
    contentHash: "a".repeat(64),
    submittedAt: "2026-07-27T00:00:00.000Z",
    uri: "https://private.example/artifact",
  })).status, 200);
  assert.equal((await post(app, "/jobs/job_01/accept", { actor: "BUYER", intent })).status, 200);
  assert.equal((await post(app, "/jobs/job_01/release", {
    intent, currentRound: 499, settlementTxId: "release_tx",
  })).status, 200);

  const res = await app.request("/receipts/job_01");
  assert.equal(res.status, 200);
  const { receipt } = (await res.json()) as { receipt: Record<string, unknown> };

  assert.equal(receipt.schema, "closeout-settlement-receipt/v1");
  assert.equal(receipt.state, "released");
  assert.equal(receipt.settlementTxId, "release_tx");
  assert.equal(receipt.taskCommitment, job.taskCommitment);

  // The public artifact must not disclose where the delivery lives.
  assert.ok(!JSON.stringify(receipt).includes("private.example"));
});
