import assert from "node:assert/strict";
import test from "node:test";

import {
  contentHash,
  deriveFindings,
  taskRequest,
  verifyDelivery,
  type ControlSurfaceReport,
} from "../src/task.ts";

const request = taskRequest(31566704);

const report = (overrides: Partial<ControlSurfaceReport> = {}): ControlSurfaceReport => {
  const base: ControlSurfaceReport = {
    schema: "closeout-demo-asset-control/v1",
    assetId: 31566704,
    unitName: "USDC",
    decimals: 6,
    total: "18446744073709551615",
    manager: "MANAGER_ADDR",
    freeze: "FREEZE_ADDR",
    clawback: "CLAWBACK_ADDR",
    reserve: null,
    defaultFrozen: false,
    findings: [],
    ...overrides,
  };
  return { ...base, findings: overrides.findings ?? deriveFindings(base) };
};

test("a well-formed report about the right asset verifies", () => {
  assert.deepEqual(verifyDelivery(request, report()), { ok: true });
});

test("a report about a different asset is refused", () => {
  // The provider answering an easier question than the one it was paid
  // for is the obvious failure, and the one a shape-only check misses.
  const verdict = verifyDelivery(request, report({ assetId: 999 }));
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && verdict.reasons.some((r) => r.includes("not 31566704")));
});

test("findings that do not follow from the fields are refused", () => {
  // A well-formed shape with an unsupported conclusion attached: the
  // report claims nobody can touch the holding while naming a clawback
  // address.
  const verdict = verifyDelivery(
    request,
    report({ findings: ["no third party can move or immobilise a holding"] }),
  );
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && verdict.reasons.some((r) => r.includes("do not follow")));
});

test("a report missing control fields is refused", () => {
  const { clawback: _omitted, ...partial } = report();
  const verdict = verifyDelivery(request, partial);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && verdict.reasons.some((r) => r.includes("missing field: clawback")));
});

test("an asset nobody controls reports exactly that", () => {
  const clean = report({ manager: null, freeze: null, clawback: null, reserve: null });
  assert.deepEqual(clean.findings, ["no third party can move or immobilise a holding"]);
  assert.deepEqual(verifyDelivery(request, clean), { ok: true });
});

test("the content hash depends on values, not key order", () => {
  // The delivery commitment is this hash, so a reordered-but-identical
  // report must not read as a different delivery.
  const a = report();
  const reordered = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(contentHash(reordered), contentHash(a));
  assert.notEqual(contentHash(report({ clawback: null })), contentHash(a));
});

test("a non-object delivery is refused rather than crashing", () => {
  assert.equal(verifyDelivery(request, "a report, honest").ok, false);
  assert.equal(verifyDelivery(request, null).ok, false);
});
