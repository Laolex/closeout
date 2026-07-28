import { ABIMethod } from "algosdk";

/**
 * The escrow's ARC-4 methods.
 *
 * These are the *contract's* names, which are not the workflow's names:
 * the delivery and acceptance transitions are `markDelivered` and
 * `markAccepted`. An earlier client called them `deliver` and `accept`
 * and passed the bare name as an app argument rather than the ARC-4
 * selector, which cannot work — every call would fail method dispatch on
 * chain, and only there. `methods.test.ts` cross-checks these signatures
 * against the compiled ARC-56 artifact so the two cannot drift again.
 */
export const CLOSEOUT_METHODS = {
  configure: ABIMethod.fromSignature("configure(address,address,uint64,uint64,uint64)void"),
  fund: ABIMethod.fromSignature("fund(axfer)void"),
  markDelivered: ABIMethod.fromSignature("markDelivered()void"),
  markAccepted: ABIMethod.fromSignature("markAccepted(byte[])void"),
  release: ABIMethod.fromSignature("release(byte[])void"),
  refund: ABIMethod.fromSignature("refund()void"),
} as const;

export type CloseoutMethodName = keyof typeof CLOSEOUT_METHODS;

/** Global schema the application is created with: 4 uints, 3 byte-slices. */
export const GLOBAL_SCHEMA = { numUint: 4, numByteSlice: 3 } as const;

/**
 * The escrow holds one ASA, so its account needs the base minimum plus
 * one asset's worth: 0.1 + 0.1 ALGO. `configure` also submits the opt-in
 * as an inner transaction with `fee: 0`, so the caller covers that fee.
 */
export const APP_MIN_BALANCE_MICROALGOS = 200_000;

/** States, matching the contract's uint64 encoding. */
export const STATE = {
  unconfigured: 0,
  awaitingFunding: 1,
  funded: 2,
  delivered: 3,
  accepted: 4,
  released: 5,
  refunded: 6,
} as const;
