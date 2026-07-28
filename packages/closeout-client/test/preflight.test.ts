import assert from "node:assert/strict";
import test from "node:test";

import algosdk from "algosdk";

import { canonicalGroupHash, preflightGroup, type PreflightReport } from "../src/preflight.ts";

const ADDR = "DPVRQA6K5SND6SCFBPEM2YEPV53FTGSPJERBP5ZRGCCUPQVUUDXB6TGRGQ";
const params = {
  fee: 1000n, firstValid: 1n, lastValid: 1001n, genesisID: "testnet-v1.0",
  genesisHash: new Uint8Array(32), minFee: 1000n, flatFee: true,
} as unknown as algosdk.SuggestedParams;

const group = (amount: number) => [
  algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: ADDR, receiver: ADDR, amount, suggestedParams: params,
  }),
];

const report = (g: algosdk.Transaction[], overrides: Partial<PreflightReport> = {}): PreflightReport => ({
  canonicalGroupHash: canonicalGroupHash(g),
  simulateSuccess: true,
  riskFlags: [],
  reportHash: "r1",
  ...overrides,
});

test("with no checker configured, a job proceeds exactly as before", async () => {
  // Closeout must not require Preflight to be running.
  const verdict = await preflightGroup(group(1), undefined);
  assert.equal(verdict.ok, true);
});

test("a clean report lets the group be signed, and yields evidence", async () => {
  const g = group(1);
  const verdict = await preflightGroup(g, async () => report(g));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reportHash, "r1");
});

test("a report about a different group refuses the signature", async () => {
  // Check one group, be handed another, sign it anyway: without the
  // binding a preflight is advisory. One microalgo is enough to differ.
  const checked = group(1);
  const handed = group(2);
  const verdict = await preflightGroup(handed, async () => report(checked));

  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /different transaction group/);
});

test("a structural flag blocks; a heuristic one does not", async () => {
  const g = group(1);
  const blocked = await preflightGroup(g, async () =>
    report(g, { riskFlags: [{ code: "REKEY", severity: "high", heuristic: false }] }),
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason ?? "", /REKEY/);

  // Ordinary DEX traffic trips heuristics; blocking on them would make
  // the check unusable.
  const allowed = await preflightGroup(g, async () =>
    report(g, { riskFlags: [{ code: "UNEXPECTED_INNER_TRANSFER", severity: "low", heuristic: true }] }),
  );
  assert.equal(allowed.ok, true);
});

test("a group that fails simulation is not signed", async () => {
  const g = group(1);
  const verdict = await preflightGroup(g, async () => report(g, { simulateSuccess: false }));
  assert.equal(verdict.ok, false);
});

test("an unreachable checker fails closed, not open", async () => {
  // "We could not check" must never look like "we checked and it was
  // fine" to a caller about to move money.
  const verdict = await preflightGroup(group(1), async () => {
    throw new Error("connection refused");
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /unavailable/);
});

test("group order is part of the identity", async () => {
  const a = group(1)[0];
  const b = group(2)[0];
  assert.notEqual(canonicalGroupHash([a, b]), canonicalGroupHash([b, a]));
});
