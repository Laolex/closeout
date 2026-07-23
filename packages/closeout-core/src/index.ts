import { createHash } from "node:crypto";

export type JobState =
  | "draft"
  | "funded"
  | "delivered"
  | "accepted"
  | "released"
  | "refunded";

export type DeliveryMode = "buyer_accepts" | "deterministic_verify";

export interface SettlementIntent {
  schema: "closeout-settlement-intent/v1";
  jobId: string;
  buyer: string;
  provider: string;
  assetId: number;
  amount: string;
  nonce: string;
  expiresAtRound: number;
}

export interface Delivery {
  contentHash: string;
  submittedAt: string;
  uri?: string;
}

export interface Job {
  id: string;
  buyer: string;
  provider: string;
  assetId: number;
  amount: string;
  expiresAtRound: number;
  deliveryMode: DeliveryMode;
  state: JobState;
  fundingTxId?: string;
  delivery?: Delivery;
  settlementIntent?: SettlementIntent;
  settlementIntentHash?: string;
  settlementTxId?: string;
  refundTxId?: string;
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  throw new TransitionError("Settlement intent contains an unsupported value");
}

export function hashSettlementIntent(intent: SettlementIntent): string {
  return createHash("sha256").update(canonicalize(intent)).digest("hex");
}

function requireValue(value: string, name: string): void {
  if (value.trim().length === 0) throw new TransitionError(`${name} is required`);
}

function requirePositiveAmount(amount: string): void {
  if (!/^[1-9][0-9]*$/.test(amount)) {
    throw new TransitionError("amount must be a positive integer in atomic units");
  }
}

export function createJob(input: Omit<Job, "state">): Job {
  requireValue(input.id, "id");
  requireValue(input.buyer, "buyer");
  requireValue(input.provider, "provider");
  requirePositiveAmount(input.amount);
  if (!Number.isInteger(input.assetId) || input.assetId < 0) {
    throw new TransitionError("assetId must be a non-negative integer");
  }
  if (!Number.isInteger(input.expiresAtRound) || input.expiresAtRound < 1) {
    throw new TransitionError("expiresAtRound must be a positive integer");
  }
  return { ...input, state: "draft" };
}

export function fund(job: Job, actor: string, fundingTxId: string): Job {
  if (job.state !== "draft") throw new TransitionError("Only a draft job can be funded");
  if (actor !== job.buyer) throw new TransitionError("Only the buyer can fund a job");
  requireValue(fundingTxId, "fundingTxId");
  return { ...job, state: "funded", fundingTxId };
}

export function submitDelivery(job: Job, actor: string, delivery: Delivery): Job {
  if (job.state !== "funded") throw new TransitionError("Only a funded job can receive a delivery");
  if (actor !== job.provider) throw new TransitionError("Only the provider can submit a delivery");
  requireValue(delivery.contentHash, "delivery.contentHash");
  requireValue(delivery.submittedAt, "delivery.submittedAt");
  return { ...job, state: "delivered", delivery: { ...delivery } };
}

export function accept(job: Job, actor: string, intent: SettlementIntent): Job {
  if (job.state !== "delivered") throw new TransitionError("Only a delivered job can be accepted");
  if (actor !== job.buyer) throw new TransitionError("Only the buyer can accept a job in this prototype");
  assertIntentMatchesJob(intent, job);
  return {
    ...job,
    state: "accepted",
    settlementIntent: { ...intent },
    settlementIntentHash: hashSettlementIntent(intent),
  };
}

export function release(job: Job, intent: SettlementIntent, currentRound: number, settlementTxId: string): Job {
  if (job.state !== "accepted") throw new TransitionError("Only an accepted job can be released");
  if (!job.settlementIntent || !job.settlementIntentHash) {
    throw new TransitionError("Accepted job has no settlement intent");
  }
  if (currentRound > intent.expiresAtRound) throw new TransitionError("Settlement intent has expired");
  assertIntentMatchesJob(intent, job);
  if (hashSettlementIntent(intent) !== job.settlementIntentHash) {
    throw new TransitionError("Settlement intent hash does not match acceptance");
  }
  requireValue(settlementTxId, "settlementTxId");
  return { ...job, state: "released", settlementTxId };
}

export function refund(job: Job, actor: string, currentRound: number, refundTxId: string): Job {
  if (!["funded", "delivered", "accepted"].includes(job.state)) {
    throw new TransitionError("Only unresolved funded jobs can be refunded");
  }
  if (actor !== job.buyer) throw new TransitionError("Only the buyer can request a refund");
  if (currentRound <= job.expiresAtRound) {
    throw new TransitionError("A job is refundable only after expiry");
  }
  requireValue(refundTxId, "refundTxId");
  return { ...job, state: "refunded", refundTxId };
}

export function assertIntentMatchesJob(intent: SettlementIntent, job: Job): void {
  if (intent.schema !== "closeout-settlement-intent/v1") throw new TransitionError("Wrong settlement intent schema");
  if (intent.jobId !== job.id) throw new TransitionError("Settlement intent jobId does not match");
  if (intent.buyer !== job.buyer) throw new TransitionError("Settlement intent buyer does not match");
  if (intent.provider !== job.provider) throw new TransitionError("Settlement intent provider does not match");
  if (intent.assetId !== job.assetId) throw new TransitionError("Settlement intent assetId does not match");
  if (intent.amount !== job.amount) throw new TransitionError("Settlement intent amount does not match");
  if (intent.expiresAtRound !== job.expiresAtRound) throw new TransitionError("Settlement intent expiry does not match");
  requireValue(intent.nonce, "settlement intent nonce");
}
