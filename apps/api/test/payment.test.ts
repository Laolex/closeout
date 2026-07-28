import assert from "node:assert/strict";
import test from "node:test";

import { createCloseoutApp } from "../src/app.js";
import { buildRequirements, httpFacilitator, type Facilitator, type PaymentConfig } from "../src/payment.js";

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

// --- the real facilitator, ported from Preflight where every one of
// these behaviours was found by a live request failing ---

function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const REQS = buildRequirements({
  payTo: "PAYTO", baseUrl: "https://closeout.example", price: "10000",
  facilitator: facilitator(),
});

test("the facilitator is sent the DECODED payment payload, not the header", async () => {
  // Forwarding the raw header fails as "Invalid payload format", which
  // reads like the caller sent something broken when the bug is ours.
  const { impl, calls } = fetchReturning(200, { isValid: true });
  await httpFacilitator("https://facilitator.example", impl).verify(HEADER, REQS);

  assert.equal(calls[0].url, "https://facilitator.example/verify");
  assert.deepEqual(calls[0].body.paymentPayload, { x402Version: 2, scheme: "exact" });
  assert.equal(calls[0].body.x402Version, 2);
});

test("HTTP 200 with isValid false is a rejection — the body is the verdict", async () => {
  // The status code says nothing. This is the one that silently accepts
  // unpaid traffic if you trust the status.
  const { impl } = fetchReturning(200, { isValid: false, invalidReason: "insufficient_funds" });
  const result = await httpFacilitator("https://facilitator.example", impl).verify(HEADER, REQS);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient_funds");
});

test("a settle that returns 200 but reports failure is not money received", async () => {
  const { impl } = fetchReturning(200, { success: false, errorReason: "expired" });
  await assert.rejects(
    () => httpFacilitator("https://facilitator.example", impl).settle(HEADER, REQS),
    /settle failed.*expired/,
  );
});

test("a successful settle resolves quietly", async () => {
  const { impl } = fetchReturning(200, { success: true, txId: "TX" });
  await httpFacilitator("https://facilitator.example", impl).settle(HEADER, REQS);
});

test("an undecodable header is the caller's problem, not an outage", async () => {
  const { impl } = fetchReturning(200, { isValid: true });
  const result = await httpFacilitator("https://facilitator.example", impl).verify("not base64 json", REQS);
  assert.equal(result.ok, false);
});

test("requirements carry the challenge tag the leaderboard indexes on", () => {
  // Untagged, the endpoint can take real paid traffic and score nothing,
  // and nothing about serving traffic reveals it.
  assert.equal(REQS.extra.tag, "x402-global-challenge");
});

test("the tag can be turned off, so a testnet run is not scored", () => {
  const r = buildRequirements({
    payTo: "PAYTO", baseUrl: "https://closeout.example", price: "10000",
    facilitator: facilitator(), tag: null,
  });
  assert.equal(r.extra.tag, undefined);
});
