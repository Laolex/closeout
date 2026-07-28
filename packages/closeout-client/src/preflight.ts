import { createHash } from "node:crypto";

import type { Transaction } from "algosdk";
import algosdk from "algosdk";

/**
 * The optional pre-sign check.
 *
 * Before signing a funding or release group, a client may send the exact
 * bytes to a Preflight endpoint, which simulates them against live state
 * and reports what will actually move. The point is that a group's real
 * effects are not visible in its bytes: an application call can emit
 * inner transfers the signed transaction never mentions, and a payment
 * can carry a close-out that sweeps the account.
 *
 * Three rules, from the spec, and all three are enforced here rather than
 * left to the caller:
 *
 * - a report never releases funds and never changes contract state. This
 *   returns a verdict; it does not sign, submit, or settle anything.
 * - the report is bound to the exact bytes it checked. If the group is
 *   modified after the check, the binding fails and signing is refused.
 * - Closeout must work without it. `preflight` is undefined by default,
 *   and a job proceeds unchecked exactly as before.
 */
export interface PreflightReport {
  canonicalGroupHash: string;
  simulateSuccess: boolean;
  riskFlags: { code: string; severity: string; heuristic: boolean }[];
  reportHash: string;
}

export interface PreflightChecker {
  (group: Transaction[]): Promise<PreflightReport>;
}

export interface PreflightVerdict {
  ok: boolean;
  reason?: string;
  report?: PreflightReport;
  /** Attachable to the job record as evidence the check was run. */
  reportHash?: string;
}

/**
 * The canonical hash of a transaction group: the encoded transactions in
 * order, hashed together. Order is part of the identity — the same
 * transactions in a different order are a different group with different
 * effects.
 */
export function canonicalGroupHash(group: Transaction[]): string {
  const bytes = Buffer.concat(group.map((txn) => Buffer.from(algosdk.encodeUnsignedTransaction(txn))));
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Runs the check and decides whether the group may be signed.
 *
 * Fails **closed** on a structural flag or a failed simulation, and on a
 * report that does not describe the group in hand. A checker that is
 * unreachable is reported as such rather than silently treated as a pass:
 * "we could not check" and "we checked and it was fine" must never look
 * the same to a caller about to move money.
 */
export async function preflightGroup(
  group: Transaction[],
  checker: PreflightChecker | undefined,
): Promise<PreflightVerdict> {
  if (!checker) return { ok: true, reason: "no preflight configured" };

  let report: PreflightReport;
  try {
    report = await checker(group);
  } catch (error) {
    return { ok: false, reason: `preflight unavailable: ${error instanceof Error ? error.message : error}` };
  }

  const expected = canonicalGroupHash(group);
  if (report.canonicalGroupHash !== expected) {
    return {
      ok: false,
      reason: "preflight report describes a different transaction group",
      report,
    };
  }
  if (!report.simulateSuccess) {
    return { ok: false, reason: "the group fails in simulation", report, reportHash: report.reportHash };
  }

  // Structural flags are read off the bytes or stated by the node; they
  // cannot be false positives, so they block. Heuristic flags are
  // surfaced, not enforced — collapsing both into "unsafe" would make the
  // check useless on ordinary traffic.
  const structural = report.riskFlags.filter((f) => !f.heuristic);
  if (structural.length > 0) {
    return {
      ok: false,
      reason: `structural risk: ${structural.map((f) => f.code).join(", ")}`,
      report,
      reportHash: report.reportHash,
    };
  }

  return { ok: true, report, reportHash: report.reportHash };
}
