import { createHash } from "node:crypto";

/**
 * x402 payment for job creation.
 *
 * The ordering here is the whole design, and it is the opposite of what
 * payment middleware does by default. Middleware verifies *and settles*
 * before the route runs, which charges callers for requests that were
 * never answerable. This drives verify and settle by hand and settles
 * **last**:
 *
 *   402 -> verify -> validate the job -> persist -> settle
 *
 * A malformed job, a duplicate id, or an unparseable body therefore costs
 * the caller nothing. Persisting before settling matters just as much: a
 * crash after settling but before persisting would take money for a job
 * that does not exist, so the worst case is deliberately a job nobody was
 * charged for. This ordering was confirmed against the live GoPlausible
 * facilitator by Preflight before being reused here.
 */
export const X402_VERSION = 2;

/** CAIP-2, not a friendly name — `algorand-mainnet` is rejected. */
export const ALGORAND_MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
export const MAINNET_USDC = "31566704";
export const USDC_DECIMALS = 6;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  /** The live catalog reads `amount`; the spec says `maxAmountRequired`. */
  amount: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: "application/json";
  maxTimeoutSeconds: number;
  extra: { decimals: number; feePayer?: string };
}

export interface VerifyResult {
  ok: boolean;
  /** Stable per payment: two requests carrying one payment share a nonce. */
  nonce: string;
  reason?: string;
}

export interface Facilitator {
  verify(header: string, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(header: string, requirements: PaymentRequirements): Promise<void>;
}

export interface PaymentConfig {
  payTo: string;
  /** Absolute origin: `resource` names a different endpoint per host. */
  baseUrl: string;
  /** Base units of USDC to create one job. */
  price: string;
  facilitator: Facilitator;
  feePayer?: string;
  network?: string;
  asset?: string;
}

export function buildRequirements(config: PaymentConfig): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network ?? ALGORAND_MAINNET,
    asset: config.asset ?? MAINNET_USDC,
    amount: config.price,
    maxAmountRequired: config.price,
    payTo: config.payTo,
    resource: `${config.baseUrl.replace(/\/+$/, "")}/jobs`,
    description:
      "Create a Closeout job: validate the terms, prepare the funding group, and issue a verifiable settlement record.",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
    extra: { decimals: USDC_DECIMALS, ...(config.feePayer ? { feePayer: config.feePayer } : {}) },
  };
}

/**
 * The decoded `X-PAYMENT` header.
 *
 * x402 carries the payment as base64 JSON. The facilitator wants the
 * decoded object as `paymentPayload`; forwarding the raw header string
 * fails as "Invalid payload format", which reads like the caller sent
 * something broken when the bug is ours.
 */
export function decodePaymentHeader(header: string): Record<string, unknown> {
  let decoded: string;
  try {
    decoded = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new PaymentError("X-PAYMENT is not base64-encoded JSON");
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new PaymentError("X-PAYMENT is not base64-encoded JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PaymentError("X-PAYMENT does not decode to an object");
  }
  return value as Record<string, unknown>;
}

/** Stable identifier for a payment, so a replay is recognisable. */
export function nonceFromHeader(header: string): string {
  return createHash("sha256").update(header).digest("hex");
}

export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

export class SettlementFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementFailed";
  }
}

/** A record of work already paid for, keyed by payment nonce. */
export interface PaidStore {
  get(nonce: string): { jobId: string; settled: boolean } | undefined;
  set(nonce: string, value: { jobId: string; settled: boolean }): void;
}

export function createMemoryPaidStore(): PaidStore {
  const entries = new Map<string, { jobId: string; settled: boolean }>();
  return { get: (n) => entries.get(n), set: (n, v) => entries.set(n, v) };
}
