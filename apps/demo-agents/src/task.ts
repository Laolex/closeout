import { createHash } from "node:crypto";

/**
 * The job the two agents actually transact over.
 *
 * An asset control-surface report: who, other than the holder, can move
 * or immobilise a holding. This is a real question with a real answer —
 * a holder deciding whether to opt into an ASA needs it, and the answer
 * is not visible from a balance. It is deliberately not a made-up errand
 * invented to generate a settlement.
 *
 * It is also *checkable*, which is what makes it a fair first demo: the
 * buyer verifies the delivery deterministically instead of forming an
 * opinion about it. Nothing here asks a model to judge quality.
 */
export interface ControlSurfaceReport {
  schema: "closeout-demo-asset-control/v1";
  assetId: number;
  unitName: string;
  decimals: number;
  total: string;
  /** Addresses that hold power over other people's holdings. */
  manager: string | null;
  freeze: string | null;
  clawback: string | null;
  reserve: string | null;
  defaultFrozen: boolean;
  /** Plain-language findings, derived only from the fields above. */
  findings: string[];
}

export interface TaskRequest {
  schema: "closeout-demo-asset-control-request/v1";
  assetId: number;
  /** What the buyer will accept, stated before any work is done. */
  requires: readonly (keyof ControlSurfaceReport)[];
}

export const REQUIRED_FIELDS = [
  "schema",
  "assetId",
  "unitName",
  "decimals",
  "total",
  "manager",
  "freeze",
  "clawback",
  "reserve",
  "defaultFrozen",
  "findings",
] as const satisfies readonly (keyof ControlSurfaceReport)[];

export function taskRequest(assetId: number): TaskRequest {
  return { schema: "closeout-demo-asset-control-request/v1", assetId, requires: REQUIRED_FIELDS };
}

/**
 * Canonical JSON, so a content hash is a function of the values rather
 * than of key order or whitespace. The delivery commitment in the job
 * record is this hash.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export function contentHash(report: unknown): string {
  return createHash("sha256").update(canonical(report)).digest("hex");
}

/** Commitment to the agreed task, salted so the request is not guessable. */
export function taskCommitment(request: TaskRequest, salt: string): string {
  return createHash("sha256").update(`closeout-demo-task${salt}${canonical(request)}`).digest("hex");
}

export interface VerdictFailure {
  ok: false;
  reasons: string[];
}
export type Verdict = { ok: true } | VerdictFailure;

/**
 * The deterministic verifier named in the job.
 *
 * Structural only, and deliberately so: it checks that the delivery is
 * the shape that was agreed, describes the asset that was asked about,
 * and states findings that follow from its own fields. It does not decide
 * whether the report is *insightful*. A verifier that tried to would be
 * the model-judges-payout rule the spec rules out.
 */
export function verifyDelivery(request: TaskRequest, delivery: unknown): Verdict {
  const reasons: string[] = [];
  if (typeof delivery !== "object" || delivery === null || Array.isArray(delivery)) {
    return { ok: false, reasons: ["delivery is not a JSON object"] };
  }
  const report = delivery as Record<string, unknown>;

  for (const field of request.requires) {
    if (!(field in report)) reasons.push(`missing field: ${field}`);
  }
  if (report.schema !== "closeout-demo-asset-control/v1") reasons.push("wrong report schema");
  if (report.assetId !== request.assetId) {
    reasons.push(`report is about asset ${String(report.assetId)}, not ${request.assetId}`);
  }
  if (typeof report.decimals !== "number") reasons.push("decimals must be a number");
  if (typeof report.total !== "string") reasons.push("total must be a decimal string");
  if (typeof report.defaultFrozen !== "boolean") reasons.push("defaultFrozen must be a boolean");
  if (!Array.isArray(report.findings)) reasons.push("findings must be an array");

  for (const role of ["manager", "freeze", "clawback", "reserve"] as const) {
    const value = report[role];
    if (value !== null && typeof value !== "string") reasons.push(`${role} must be an address or null`);
  }

  // The findings must follow from the report's own fields. This is what
  // stops a provider from returning a well-formed shape with an
  // unsupported conclusion attached.
  if (Array.isArray(report.findings)) {
    const expected = deriveFindings(report as unknown as ControlSurfaceReport);
    if (canonical([...report.findings].sort()) !== canonical([...expected].sort())) {
      reasons.push("findings do not follow from the reported control fields");
    }
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** The only findings the report is allowed to state, given its fields. */
export function deriveFindings(report: ControlSurfaceReport): string[] {
  const findings: string[] = [];
  if (report.clawback) findings.push("clawback address set: holdings can be revoked by a third party");
  if (report.freeze) findings.push("freeze address set: holdings can be immobilised by a third party");
  if (report.defaultFrozen) findings.push("default frozen: holdings are unusable until unfrozen");
  if (report.manager) findings.push("manager address set: asset roles can be reconfigured");
  if (findings.length === 0) findings.push("no third party can move or immobilise a holding");
  return findings;
}
