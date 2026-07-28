import assert from "node:assert/strict";
import test from "node:test";

import { createCloseoutApp } from "../src/app.js";
import { buildRequirements, type Facilitator, type PaymentConfig } from "../src/payment.js";

const job = {
  id: "job_paid",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "100000",
  expiresAtRound: 500,
  deliveryMode: "buyer_accepts",
  taskCommitment: "b".repeat(64),
};

const HEADER = Buffer.from(JSON.stringify({ x402Version: 2, scheme: "exact" })).toString("base64");

function facilitator(overrides: Partial<Facilitator> & { calls?: string[] } = {}) {
  const calls: string[] = overrides.calls ?? [];
  return {
    calls,
    verify: overrides.verify ?? (async () => { calls.push("verify"); return { ok: true, nonce: "n1" }; }),
    settle: overrides.settle ?? (async () => { calls.push("settle"); }),
  };
}

function paidApp(f: Facilitator, extra: Partial<PaymentConfig> = {}) {
  return createCloseoutApp({
    payment: {
      payTo: "PAYTO",
      baseUrl: "https://closeout.example",
      price: "10000",
      facilitator: f,
      ...extra,
    },
  });
}

const post = (app: ReturnType<typeof createCloseoutApp>, body: unknown, header?: string) =>
  app.request("/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "x-payment": header } : {}) },
    body: JSON.stringify(body),
  });

test("an unpaid request is answered with the requirements, not the work", async () => {
  const res = await post(paidApp(facilitator()), job);
  assert.equal(res.status, 402);

  const body = (await res.json()) as { x402Version: number; accepts: { resource: string }[] };
  assert.equal(body.x402Version, 2);
  // `resource` must be absolute: a bare path names a different endpoint
  // on every host that serves it.
  assert.equal(body.accepts[0].resource, "https://closeout.example/jobs");
});

test("a paid request creates the job and settles last", async () => {
  const f = facilitator();
  const res = await post(paidApp(f), job, HEADER);

  assert.equal(res.status, 201);
  assert.deepEqual(f.calls, ["verify", "settle"]);
});

test("a malformed job is never settled", async () => {
  // The reason settlement is driven by hand: middleware would already
  // have charged for this.
  const f = facilitator();
  const res = await post(paidApp(f), { ...job, amount: "not-a-number" }, HEADER);

  // 409 is this app's existing convention for a rejected transition.
  assert.equal(res.status, 409);
  assert.deepEqual(f.calls, ["verify"]);
});

test("a rejected payment buys nothing", async () => {
  const f = facilitator({ verify: async () => ({ ok: false, nonce: "n1", reason: "insufficient" }) });
  const app = paidApp(f);

  assert.equal((await post(app, job, HEADER)).status, 402);
  assert.equal((await app.request("/jobs/job_paid")).status, 404);
});

test("a settlement failure is a 502, never a 200 with the work attached", async () => {
  // Otherwise the endpoint is free to anyone whose settlement
  // conveniently errors.
  const f = facilitator({ settle: async () => { throw new Error("facilitator down"); } });
  const res = await post(paidApp(f), job, HEADER);

  assert.equal(res.status, 502);
  assert.match((await res.json() as { error: string }).error, /settlement failed/);
});

test("replaying a paid request returns the same job without charging again", async () => {
  const f = facilitator();
  const app = paidApp(f);

  assert.equal((await post(app, job, HEADER)).status, 201);
  const replay = await post(app, job, HEADER);

  assert.equal(replay.status, 201);
  assert.equal((await replay.json() as { job: { id: string } }).job.id, "job_paid");
  assert.deepEqual(f.calls, ["verify", "settle"], "the replay must not settle a second time");
});

test("job creation stays free when no payment is configured", async () => {
  assert.equal((await post(createCloseoutApp(), job)).status, 201);
});

test("the price is published under both names the ecosystem uses", () => {
  const r = buildRequirements({
    payTo: "PAYTO", baseUrl: "https://closeout.example", price: "10000",
    facilitator: facilitator(),
  });
  assert.equal(r.amount, "10000");
  assert.equal(r.maxAmountRequired, r.amount);
  assert.equal(r.network, "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=");
});
