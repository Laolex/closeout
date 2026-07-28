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
  extra: { decimals: number; feePayer?: string; tag?: string };
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

/**
 * Entry into the Algorand Global x402 Challenge is carried in the
 * published requirements, not in a registration form: the leaderboard
 * indexes resources whose `extra.tag` is this string. An untagged
 * endpoint still takes real payments and still answers — it simply
 * scores nothing, and nothing about serving traffic reveals that.
 */
export const CHALLENGE_TAG = "x402-global-challenge";

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
  /**
   * Leaderboard tag published as `extra.tag`. Defaults to the challenge
   * entry; pass `null` for a deployment that should not be scored.
   */
  tag?: string | null;
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
    extra: {
      decimals: USDC_DECIMALS,
      ...(config.feePayer ? { feePayer: config.feePayer } : {}),
      ...(config.tag === null ? {} : { tag: config.tag ?? CHALLENGE_TAG }),
    },
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

interface FacilitatorResponse {
  isValid?: boolean;
  valid?: boolean;
  invalidReason?: string;
  errorReason?: string;
  error?: string;
  success?: boolean;
  nonce?: string;
  txId?: string;
}

/**
 * The live GoPlausible facilitator.
 *
 * Ported from Preflight, where every behaviour encoded here was found by
 * a request failing rather than by reading the spec:
 *
 * - `/verify` and `/settle` want the **decoded** `X-PAYMENT` object as
 *   `paymentPayload`. Forwarding the raw header string fails as
 *   "Invalid payload format", which reads like the caller sent something
 *   broken when the bug is ours.
 * - `/verify` answers **HTTP 200 with `isValid: false`** for a rejected
 *   payment. The status code says nothing; the body is the verdict.
 *   Trusting the status silently serves unpaid traffic.
 * - a settle can likewise return 200 while reporting failure, and that
 *   must never be recorded as money received.
 */
export function httpFacilitator(baseUrl: string, fetchImpl: typeof fetch = fetch): Facilitator {
  const post = async (path: string, header: string, requirements: PaymentRequirements) => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload: decodePaymentHeader(header),
        paymentRequirements: requirements,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as FacilitatorResponse;
    return { status: res.status, json };
  };

  const reasonOf = (json: FacilitatorResponse): string | undefined =>
    json.invalidReason ?? json.errorReason ?? json.error;

  return {
    async verify(header, requirements) {
      let result: { status: number; json: FacilitatorResponse };
      try {
        result = await post("/verify", header, requirements);
      } catch (error) {
        // An undecodable header is the caller's problem, and is reported
        // as such rather than as an unreachable facilitator.
        return { ok: false, nonce: "", reason: (error as Error).message };
      }

      if (result.status < 200 || result.status >= 300) {
        return {
          ok: false,
          nonce: "",
          reason: reasonOf(result.json) ?? `facilitator verify returned ${result.status}`,
        };
      }
      if (!(result.json.isValid ?? result.json.valid ?? false)) {
        return { ok: false, nonce: "", reason: reasonOf(result.json) ?? "payment rejected" };
      }
      return { ok: true, nonce: result.json.nonce ?? nonceFromHeader(header) };
    },

    async settle(header, requirements) {
      const { status, json } = await post("/settle", header, requirements);
      const settled = status >= 200 && status < 300 && json.success !== false && json.isValid !== false;
      if (!settled) {
        throw new Error(`facilitator settle failed (${status}): ${reasonOf(json) ?? "no reason given"}`);
      }
    },
  };
}
