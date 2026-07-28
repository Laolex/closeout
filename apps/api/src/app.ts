import { Hono } from "hono";
import {
  X402_VERSION,
  buildRequirements,
  createMemoryPaidStore,
  nonceFromHeader,
  type PaidStore,
  type PaymentConfig,
} from "./payment.js";
import { buildTimeline, renderTimeline } from "@closeout/console";
import {
  TransitionError,
  accept,
  createJob,
  fund,
  deriveReceipt,
  refund,
  release,
  submitDelivery,
  type Delivery,
  type Job,
  type SettlementIntent,
} from "@closeout/core";

export interface JobStore {
  get(id: string): Job | undefined;
  set(job: Job): void;
}

export function createMemoryStore(): JobStore {
  const jobs = new Map<string, Job>();
  return { get: (id) => jobs.get(id), set: (job) => jobs.set(job.id, job) };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TransitionError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TransitionError(`${name} must be a string`);
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isInteger(value)) throw new TransitionError(`${name} must be an integer`);
  return value as number;
}

function jobFromBody(body: Record<string, unknown>): Job {
  return createJob({
    id: text(body.id, "id"),
    buyer: text(body.buyer, "buyer"),
    provider: text(body.provider, "provider"),
    assetId: integer(body.assetId, "assetId"),
    amount: text(body.amount, "amount"),
    expiresAtRound: integer(body.expiresAtRound, "expiresAtRound"),
    taskCommitment: text(body.taskCommitment, "taskCommitment"),
    deliveryMode: body.deliveryMode === "buyer_accepts" || body.deliveryMode === "deterministic_verify"
      ? body.deliveryMode
      : (() => { throw new TransitionError("deliveryMode is invalid"); })(),
  });
}

function intentFromBody(body: Record<string, unknown>): SettlementIntent {
  return {
    schema: "closeout-settlement-intent/v1",
    jobId: text(body.jobId, "intent.jobId"),
    buyer: text(body.buyer, "intent.buyer"),
    provider: text(body.provider, "intent.provider"),
    assetId: integer(body.assetId, "intent.assetId"),
    amount: text(body.amount, "intent.amount"),
    nonce: text(body.nonce, "intent.nonce"),
    expiresAtRound: integer(body.expiresAtRound, "intent.expiresAtRound"),
  };
}

export interface CloseoutOptions {
  store?: JobStore;
  /** Omit to leave job creation free, as the prototype was. */
  payment?: PaymentConfig;
  paidStore?: PaidStore;
}

export function createCloseoutApp(
  storeOrOptions: JobStore | CloseoutOptions = createMemoryStore(),
): Hono {
  const options: CloseoutOptions =
    "get" in storeOrOptions && "set" in storeOrOptions
      ? { store: storeOrOptions as JobStore }
      : (storeOrOptions as CloseoutOptions);
  const store = options.store ?? createMemoryStore();
  const payment = options.payment;
  const paid = options.paidStore ?? createMemoryPaidStore();
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TransitionError) return c.json({ error: error.message }, 409);
    return c.json({ error: "Unexpected server error" }, 500);
  });

  app.post("/jobs", async (c) => {
    if (!payment) {
      const job = jobFromBody(record(await c.req.json()));
      if (store.get(job.id)) return c.json({ error: "Job already exists" }, 409);
      store.set(job);
      return c.json({ job }, 201);
    }

    const requirements = buildRequirements(payment);
    const header = c.req.header("x-payment");
    if (!header) {
      return c.json({ x402Version: X402_VERSION, error: "payment required", accepts: [requirements] }, 402);
    }

    const nonce = nonceFromHeader(header);
    const already = paid.get(nonce);
    if (already) {
      // A replay of a paid request returns the work it bought rather
      // than charging again or creating a second job.
      const existing = store.get(already.jobId);
      if (existing) return c.json({ job: existing }, 201);
    }

    const verified = await payment.facilitator.verify(header, requirements);
    if (!verified.ok) return c.json({ error: verified.reason ?? "payment rejected" }, 402);

    // Validation happens after verification but before settlement, so a
    // malformed job costs the caller nothing.
    const job = jobFromBody(record(await c.req.json()));
    if (store.get(job.id)) return c.json({ error: "Job already exists" }, 409);

    // Persist before settling: a crash here loses our fee, never their
    // money for a job that does not exist.
    store.set(job);
    paid.set(nonce, { jobId: job.id, settled: false });

    try {
      await payment.facilitator.settle(header, requirements);
    } catch (error) {
      // Never 200 with the work attached on a settlement failure, or the
      // endpoint is free to anyone whose settlement conveniently errors.
      return c.json(
        { error: `settlement failed: ${error instanceof Error ? error.message : String(error)}` },
        502,
      );
    }
    paid.set(nonce, { jobId: job.id, settled: true });
    return c.json({ job }, 201);
  });

  app.get("/jobs/:id", (c) => {
    const job = store.get(c.req.param("id"));
    return job ? c.json({ job }) : c.json({ error: "Job not found" }, 404);
  });

  app.post("/jobs/:id/funding", async (c) => {
    const current = requireJob(store, c.req.param("id"));
    const body = record(await c.req.json());
    const job = fund(current, text(body.actor, "actor"), text(body.fundingTxId, "fundingTxId"));
    store.set(job);
    return c.json({ job });
  });

  app.post("/jobs/:id/deliveries", async (c) => {
    const current = requireJob(store, c.req.param("id"));
    const body = record(await c.req.json());
    const delivery: Delivery = {
      contentHash: text(body.contentHash, "contentHash"),
      submittedAt: text(body.submittedAt, "submittedAt"),
      ...(typeof body.uri === "string" ? { uri: body.uri } : {}),
    };
    const job = submitDelivery(current, text(body.actor, "actor"), delivery);
    store.set(job);
    return c.json({ job });
  });

  app.post("/jobs/:id/accept", async (c) => {
    const current = requireJob(store, c.req.param("id"));
    const body = record(await c.req.json());
    const intent = intentFromBody(record(body.intent));
    const job = accept(current, text(body.actor, "actor"), intent);
    store.set(job);
    return c.json({ job });
  });

  app.post("/jobs/:id/release", async (c) => {
    const current = requireJob(store, c.req.param("id"));
    const body = record(await c.req.json());
    const intent = intentFromBody(record(body.intent));
    const job = release(
      current,
      intent,
      integer(body.currentRound, "currentRound"),
      text(body.settlementTxId, "settlementTxId"),
    );
    store.set(job);
    return c.json({ job });
  });

  app.post("/jobs/:id/refund", async (c) => {
    const current = requireJob(store, c.req.param("id"));
    const body = record(await c.req.json());
    const job = refund(
      current,
      text(body.actor, "actor"),
      integer(body.currentRound, "currentRound"),
      text(body.refundTxId, "refundTxId"),
    );
    store.set(job);
    return c.json({ job });
  });

  /**
   * The receipt for a settled job.
   *
   * Public on purpose, and derived rather than stored: it is the artifact
   * a third party checks. It names commitments and transaction ids only —
   * never the task text or the delivery location.
   */
  app.get("/receipts/:id", (c) => {
    const job = requireJob(store, c.req.param("id"));
    return c.json({ receipt: deriveReceipt(job) });
  });

  /**
   * The job timeline as a page, for a person rather than a client.
   * Same record as GET /jobs/:id, rendered — and it discloses no more.
   */
  app.get("/console/:id", (c) => {
    const job = requireJob(store, c.req.param("id"));
    return c.html(renderTimeline(buildTimeline(job)));
  });

  return app;
}

function requireJob(store: JobStore, id: string): Job {
  const job = store.get(id);
  if (!job) throw new TransitionError("Job not found");
  return job;
}
