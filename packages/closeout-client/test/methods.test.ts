import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ABIMethod } from "algosdk";

import { CLOSEOUT_METHODS, GLOBAL_SCHEMA } from "../src/methods.ts";

const ARC56 = fileURLToPath(
  new URL(
    "../../closeout-contract/smart_contracts/artifacts/closeout_escrow/CloseoutEscrow.arc56.json",
    import.meta.url,
  ),
);

interface Arc56Method {
  name: string;
  args: { type: string }[];
  returns: { type: string };
}

function compiledMethods(): Arc56Method[] {
  return JSON.parse(readFileSync(ARC56, "utf8")).methods as Arc56Method[];
}

function signatureOf(m: Arc56Method): string {
  return `${m.name}(${m.args.map((a) => a.type).join(",")})${m.returns.type}`;
}

test("every client method matches a method the contract actually compiled", () => {
  // The failure this prevents is invisible off-chain: a wrong name or
  // argument type still builds a valid-looking transaction and only
  // fails at method dispatch, on a live network, after fees.
  const compiled = new Map(compiledMethods().map((m) => [m.name, signatureOf(m)]));

  for (const [name, method] of Object.entries(CLOSEOUT_METHODS)) {
    const onChain = compiled.get(name);
    assert.ok(onChain, `contract has no method named ${name}`);
    assert.equal(
      method.getSignature(),
      onChain,
      `${name} signature drifted from the compiled contract`,
    );
  }
});

test("the client covers every method the contract exposes", () => {
  // Otherwise a transition could exist on-chain with no way to drive it.
  const compiled = compiledMethods().map((m) => m.name).sort();
  assert.deepEqual(Object.keys(CLOSEOUT_METHODS).sort(), compiled);
});

test("selectors are the ARC-4 hash, not the bare method name", () => {
  // The earlier client passed `new TextEncoder().encode("fund")` as the
  // first app argument. That is 4 bytes and looks plausible next to a
  // 4-byte selector, which is exactly why it survived review.
  const selector = CLOSEOUT_METHODS.fund.getSelector();
  assert.equal(selector.length, 4);
  assert.notDeepEqual(selector, new TextEncoder().encode("fund"));
  assert.deepEqual(selector, ABIMethod.fromSignature("fund(axfer)void").getSelector());
});

test("the declared global schema matches the contract's state", () => {
  const schema = JSON.parse(readFileSync(ARC56, "utf8")).state.schema.global;
  assert.equal(GLOBAL_SCHEMA.numUint, schema.ints);
  assert.equal(GLOBAL_SCHEMA.numByteSlice, schema.bytes);
});
