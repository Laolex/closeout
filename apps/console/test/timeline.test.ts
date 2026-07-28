import assert from "node:assert/strict";
import test from "node:test";

import type { Job } from "@closeout/core";

import { buildTimeline, nextAction } from "../src/timeline.ts";

const base: Job = {
  id: "job_01",
  buyer: "BUYER",
  provider: "PROVIDER",
  assetId: 31566704,
  amount: "25000",
  expiresAtRound: 500,
  deliveryMode: "deterministic_verify",
  taskCommitment: "b".repeat(64),
  state: "draft",
};

const delivered: Job = {
  ...base,
  state: "delivered",
  fundingTxId: "fund_tx",
  delivery: {
    contentHash: "a".repeat(64),
    submittedAt: "2026-07-28T00:00:00.000Z",
    uri: "https://private.example/artifact",
  },
};

const released: Job = {
  ...delivered,
  state: "released",
  settlementIntentHash: "c".repeat(64),
  settlementTxId: "release_tx",
};

test("the timeline never shows where a delivery lives", () => {
  // The console is the page a person is most likely to screenshot or
  // share, so a leak here is the most public one available.
  const rendered = JSON.stringify(buildTimeline(released));
  assert.ok(!rendered.includes("private.example"));
  assert.ok(rendered.includes("aaaaaaaaaaaa"), "the commitment itself should be shown");
});

test("a released job reads as paid, with every step done", () => {
  const timeline = buildTimeline(released);
  assert.equal(timeline.headline, "Paid to the provider");
  assert.ok(timeline.steps.every((s) => s.state === "done"));
  assert.equal(timeline.steps.at(-1)?.label, "Released");
  assert.equal(timeline.steps.at(-1)?.txId, "release_tx");
});

test("a refunded job marks the steps that never happened as skipped, not done", () => {
  // Showing them as done would claim a delivery and an acceptance that
  // do not exist.
  const refunded: Job = { ...base, state: "refunded", fundingTxId: "fund_tx", refundTxId: "refund_tx" };
  const timeline = buildTimeline(refunded);

  assert.equal(timeline.headline, "Returned to the buyer");
  assert.equal(timeline.steps.find((s) => s.label === "Delivery submitted")?.state, "skipped");
  assert.equal(timeline.steps.at(-1)?.label, "Refunded after expiry");
});

test("an unfinished job still shows the steps that have not happened", () => {
  const timeline = buildTimeline(delivered);
  assert.equal(timeline.headline, "In progress");
  assert.equal(timeline.steps.find((s) => s.label === "Funded")?.state, "done");
  assert.equal(timeline.steps.at(-1)?.state, "pending");
});

test("acceptance is labelled by how it was actually authorised", () => {
  // Never an unsupported claim about a model approving anything: either
  // a named verifier passed, or the buyer signed.
  assert.ok(buildTimeline(released).steps.some((s) => s.label === "Accepted — verifier passed"));
  assert.ok(
    buildTimeline({ ...released, deliveryMode: "buyer_accepts" }).steps.some(
      (s) => s.label === "Accepted — buyer signed",
    ),
  );
});

test("exactly one party is named as able to act next", () => {
  assert.match(nextAction(base), /Buyer funds/);
  assert.match(nextAction({ ...base, state: "funded" }), /Provider submits/);
  assert.match(nextAction(delivered), /verifier/);
  assert.match(nextAction({ ...delivered, state: "accepted" }), /Either party/);
  assert.match(nextAction(released), /^None/);
});

test("the rendered page escapes job values rather than trusting them", async () => {
  // Job ids and addresses arrive from an API request, so they are
  // attacker-controlled text on a page a third party opens.
  const { renderTimeline } = await import("../src/render.ts");
  const html = renderTimeline(buildTimeline({ ...released, id: '"><script>alert(1)</script>' }));

  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&#60;script&#62;"));
});

test("the rendered page needs no script and no network", async () => {
  // It renders a settlement record: an archived copy must still read
  // correctly years later.
  const { renderTimeline } = await import("../src/render.ts");
  const html = renderTimeline(buildTimeline(released));

  assert.ok(!/<script/i.test(html));
  assert.ok(!/https?:\/\//i.test(html.replace(/lang="en"|charset|viewport/g, "")));
  assert.ok(html.includes("release_tx"));
});
