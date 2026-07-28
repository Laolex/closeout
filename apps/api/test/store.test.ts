import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCloseoutApp } from "../src/app.js";
import { createFileJobStore, createFilePaidStore } from "../src/durable.js";
import type { Facilitator } from "../src/payment.js";

const job = {
  id: "job_durable",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "100000",
  expiresAtRound: 500,
  deliveryMode: "buyer_accepts",
  taskCommitment: "b".repeat(64),
};

const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact" })).toString("base64");

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "closeout-"));
  return { path: join(dir, "closeout.log"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const post = (app: ReturnType<typeof createCloseoutApp>, body: unknown, header?: string) =>
  app.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "x-payment": header } : {}) },
    body: JSON.stringify(body),
  });

test("a job survives a restart", async () => {
  const db = tempDb();
  try {
    const first = createFileJobStore(db.path);
    assert.equal((await post(createCloseoutApp(first), job)).status, 201);
    first.close();

    // A second process opening the same file must see the job.
    const second = createFileJobStore(db.path);
    const res = await createCloseoutApp(second).request("/jobs/job_durable");
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { job: { id: string } }).job.id, "job_durable");
    second.close();
  } finally {
    db.cleanup();
  }
});

test("a job round-trips with its delivery, intent and transaction ids intact", async () => {
  // A receipt is derived from the stored record, so anything lost in
  // storage is missing from the settlement record.
  const db = tempDb();
  try {
    const store = createFileJobStore(db.path);
    const app = createCloseoutApp(store);
    const send = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    await post(app, job);
    await send("/jobs/job_durable/funding", { actor: "BUYER", fundingTxId: "fund_tx" });
    await send("/jobs/job_durable/deliveries", {
      actor: "PROVIDER", contentHash: "a".repeat(64), submittedAt: "2026-07-28T00:00:00.000Z",
      uri: "https://private.example/artifact",
    });
    const intent = {
      schema: "closeout-settlement-intent/v1", jobId: "job_durable", buyer: "BUYER", provider: "PROVIDER",
      assetId: 31566704, amount: "100000", nonce: "n1", expiresAtRound: 500,
    };
    await send("/jobs/job_durable/accept", { actor: "BUYER", intent });
    await send("/jobs/job_durable/release", { intent, currentRound: 499, settlementTxId: "release_tx" });
    store.close();

    const reopened = createFileJobStore(db.path);
    const receipt = await createCloseoutApp(reopened).request("/receipts/job_durable");
    assert.equal(receipt.status, 200);

    const body = (await receipt.json()) as { receipt: Record<string, unknown> };
    assert.equal(body.receipt.state, "released");
    assert.equal(body.receipt.settlementTxId, "release_tx");
    assert.equal(body.receipt.fundingTxId, "fund_tx");
    assert.equal(body.receipt.deliveryCommitment, "a".repeat(64));
    assert.ok(body.receipt.settlementIntentHash, "the accepted intent hash must survive storage");
    reopened.close();
  } finally {
    db.cleanup();
  }
});

test("a paid request replayed after a restart does not settle twice", async () => {
  // The reason this store has to be durable. With the record in memory,
  // a restart between settling and a replay charges the caller a second
  // time for one job.
  const db = tempDb();
  const calls: string[] = [];
  const facilitator: Facilitator = {
    verify: async () => { calls.push("verify"); return { ok: true, nonce: "n1" }; },
    settle: async () => { calls.push("settle"); },
  };

  try {
    const jobs1 = createFileJobStore(db.path);
    const paid1 = createFilePaidStore(`${db.path}.paid`);
    const app1 = createCloseoutApp({
      store: jobs1, paidStore: paid1,
      payment: { payTo: "PAYTO", baseUrl: "https://closeout.example", price: "10000", facilitator },
    });
    assert.equal((await post(app1, job, HEADER)).status, 201);
    assert.deepEqual(calls, ["verify", "settle"]);
    jobs1.close();
    paid1.close();

    // Restart, same files, same payment replayed.
    const jobs2 = createFileJobStore(db.path);
    const paid2 = createFilePaidStore(`${db.path}.paid`);
    const app2 = createCloseoutApp({
      store: jobs2, paidStore: paid2,
      payment: { payTo: "PAYTO", baseUrl: "https://closeout.example", price: "10000", facilitator },
    });
    const replay = await post(app2, job, HEADER);

    assert.equal(replay.status, 201);
    assert.deepEqual(calls, ["verify", "settle"], "the replay must not settle again after a restart");
    jobs2.close();
    paid2.close();
  } finally {
    db.cleanup();
  }
});

test("amounts survive as exact strings, not as numbers", async () => {
  // Atomic units exceed what a JS number holds exactly. A round-trip
  // through a numeric column silently changes what was owed.
  const db = tempDb();
  try {
    const store = createFileJobStore(db.path);
    const huge = { ...job, id: "job_huge", amount: "18446744073709551615" };
    assert.equal((await post(createCloseoutApp(store), huge)).status, 201);
    store.close();

    const reopened = createFileJobStore(db.path);
    const res = await createCloseoutApp(reopened).request("/jobs/job_huge");
    assert.equal((await res.json() as { job: { amount: string } }).job.amount, "18446744073709551615");
    reopened.close();
  } finally {
    db.cleanup();
  }
});

test("a partial final line from a killed process does not destroy the log", async () => {
  // A process killed mid-append leaves a truncated line. It was never
  // acknowledged, so it should vanish — without taking every earlier
  // record with it.
  const db = tempDb();
  try {
    const store = createFileJobStore(db.path);
    assert.equal((await post(createCloseoutApp(store), job)).status, 201);
    store.close();

    appendFileSync(db.path, '{"key":"job_broken","value":{"id":"job_bro');

    const reopened = createFileJobStore(db.path);
    const app = createCloseoutApp(reopened);
    assert.equal((await app.request("/jobs/job_durable")).status, 200, "the intact record must survive");
    assert.equal((await app.request("/jobs/job_broken")).status, 404, "the partial record must not appear");

    // And the store must still accept writes afterwards.
    assert.equal((await post(app, { ...job, id: "job_after" })).status, 201);
    reopened.close();
  } finally {
    db.cleanup();
  }
});
