import type { Job } from "@closeout/core";

/**
 * One step of the job's life, as a person reads it.
 *
 * The view is a job timeline, not a chain explorer: each step names who
 * acted, what was committed, and which transaction recorded it. A step
 * that has not happened is still listed, so the shape of the agreement is
 * visible from the start rather than appearing as it goes.
 */
export interface TimelineStep {
  label: string;
  state: "done" | "pending" | "skipped";
  actor?: string;
  detail?: string;
  /** A commitment hash — never the content it commits to. */
  commitment?: string;
  txId?: string;
}

export interface Timeline {
  jobId: string;
  headline: string;
  steps: TimelineStep[];
  /** What may legitimately happen next, and who may do it. */
  nextAction: string;
}

const short = (hash: string) => `${hash.slice(0, 12)}…${hash.slice(-6)}`;

export function buildTimeline(job: Job): Timeline {
  const settled = job.state === "released" || job.state === "refunded";
  const reached = (...states: Job["state"][]) => states.includes(job.state);

  const steps: TimelineStep[] = [
    {
      label: "Task committed",
      state: "done",
      actor: job.buyer,
      detail: `${job.amount} units of asset ${job.assetId}`,
      commitment: short(job.taskCommitment),
    },
    {
      label: "Funded",
      state: job.state === "draft" ? "pending" : "done",
      actor: job.buyer,
      txId: job.fundingTxId,
    },
    {
      label: "Delivery submitted",
      state: job.delivery ? "done" : job.state === "refunded" ? "skipped" : "pending",
      actor: job.delivery ? job.provider : undefined,
      detail: job.delivery?.submittedAt,
      commitment: job.delivery ? short(job.delivery.contentHash) : undefined,
    },
    {
      label:
        job.deliveryMode === "deterministic_verify"
          ? "Accepted — verifier passed"
          : "Accepted — buyer signed",
      state: reached("accepted", "released") ? "done" : job.state === "refunded" ? "skipped" : "pending",
      actor: reached("accepted", "released") ? job.buyer : undefined,
      commitment: job.settlementIntentHash ? short(job.settlementIntentHash) : undefined,
    },
    job.state === "refunded"
      ? {
          label: "Refunded after expiry",
          state: "done",
          actor: job.buyer,
          detail: `unresolved past round ${job.expiresAtRound}`,
          txId: job.refundTxId,
        }
      : {
          label: "Released",
          state: job.state === "released" ? "done" : "pending",
          detail: job.state === "released" ? "either party may submit once accepted" : undefined,
          txId: job.settlementTxId,
        },
  ];

  return {
    jobId: job.id,
    headline: settled
      ? job.state === "released"
        ? "Paid to the provider"
        : "Returned to the buyer"
      : "In progress",
    steps,
    nextAction: nextAction(job),
  };
}

/**
 * The single next legitimate move.
 *
 * Deliberately not a list of buttons: at every point in this workflow
 * exactly one party can act, and saying which one is most of what a
 * person opening this page wants to know.
 */
export function nextAction(job: Job): string {
  switch (job.state) {
    case "draft":
      return "Buyer funds the escrow";
    case "funded":
      return "Provider submits a delivery";
    case "delivered":
      return job.deliveryMode === "deterministic_verify"
        ? "Buyer runs the agreed verifier, then accepts or lets it expire"
        : "Buyer accepts, or lets it expire";
    case "accepted":
      return "Either party submits the release";
    case "released":
      return "None — settled, and the receipt is verifiable against the chain";
    case "refunded":
      return "None — the budget returned to the buyer";
  }
}
