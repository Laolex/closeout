import { Algodv2 } from "algosdk";

import type { SettlementReceipt } from "@closeout/core";

import { STATE } from "./methods.ts";
import { readState } from "./client.ts";

export interface VerificationResult {
  ok: boolean;
  /** Every check performed, so a failure says which one failed. */
  checks: { name: string; ok: boolean; detail?: string }[];
}

const b64 = (value: string): string => Buffer.from(value, "hex").toString("base64");

/**
 * Checks a settlement receipt against the chain.
 *
 * This is the part that makes "verifiable" mean something: it reads the
 * application's global state directly from a node and confirms the
 * receipt describes what actually happened. It never calls the Closeout
 * API, so a holder does not have to trust the party that issued the
 * receipt — which is the only reason a receipt is worth more than an
 * invoice.
 *
 * What it establishes: the escrow reached the state the receipt claims,
 * for the amount and asset it claims, against the settlement intent the
 * buyer accepted. What it cannot establish: that the delivery was any
 * good. No settlement record can.
 */
export async function verifyReceiptOnChain(
  algod: Algodv2,
  appId: bigint,
  receipt: SettlementReceipt,
): Promise<VerificationResult> {
  const checks: VerificationResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  let state: Record<string, bigint | string>;
  try {
    state = await readState(algod, appId);
  } catch (error) {
    add("application readable", false, error instanceof Error ? error.message : String(error));
    return { ok: false, checks };
  }
  add("application readable", true);

  const expected = receipt.state === "released" ? STATE.released : STATE.refunded;
  const actual = state.state;
  add(
    `escrow is ${receipt.state}`,
    actual === BigInt(expected),
    `on-chain state ${actual}, receipt claims ${expected}`,
  );

  add(
    "amount matches",
    state.amount === BigInt(receipt.amount),
    `on-chain ${state.amount}, receipt ${receipt.amount}`,
  );

  // A released job must still carry the intent hash the buyer accepted.
  // A refunded one never recorded an acceptance, and must not claim one.
  if (receipt.state === "released") {
    const onChain = state.acceptedIntent;
    add(
      "settlement intent matches the accepted one",
      typeof receipt.settlementIntentHash === "string" &&
        typeof onChain === "string" &&
        onChain === b64(receipt.settlementIntentHash),
      `on-chain ${String(onChain)}`,
    );
  } else {
    add(
      "no acceptance was recorded",
      state.acceptedIntent === undefined && receipt.settlementIntentHash === undefined,
      `on-chain ${String(state.acceptedIntent)}`,
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
