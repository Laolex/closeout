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
