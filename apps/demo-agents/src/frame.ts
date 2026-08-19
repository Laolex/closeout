/**
 * The one shot that explains Closeout.
 *
 * Everything else in this repository argues that a settlement record is
 * worth more than an invoice. This prints the argument as a single
 * picture: one real settlement, checked twice, where the two receipts
 * differ by exactly one field and only one of them survives contact with
 * the chain.
 *
 *   pnpm --filter @closeout/demo-agents frame
 *
 * It needs no key, no funds and no Closeout API — only a public Algorand
 * node. That is the point being made, so it would be self-defeating to
 * demonstrate it from a privileged position.
 */
import { Algodv2, encodeAddress } from "algosdk";

import type { SettlementReceipt } from "@closeout/core";
import { readState, verifyReceiptOnChain, type VerificationResult } from "@closeout/client";

/** The two-agent demo settlement recorded in TESTNET-RUN.md. */
export const DEMO = {
  appId: 768202344n,
  assetId: 768202339,
  amount: "25000",
  fundingTxId: "XUDQFHQM2AIQKGPCSKJY7VR2P4MFJAKFPZHRMJNR6QEEXJ345SCQ",
  settlementTxId: "KBMU5ASBDIAMZP4BBVKQCMYHV26XCMWYKDHKSTHWKDVCZ6UX4IBQ",
} as const;

const PAD = 26;

export interface FrameRow {
  label: string;
  refused: string;
  settled: string;
}

/**
 * Renders the comparison as two columns.
 *
 * The refused column comes first deliberately. A reader who stops after
 * three seconds should leave knowing that this system declines things,
 * not that it succeeded at one.
 */
export function renderFrame(title: string, rows: FrameRow[], footer: string[]): string {
  const width = Math.max(...rows.map((r) => r.refused.length), 12);
  const line = "─".repeat(PAD + width + 24);
  const out = [
    line,
    `  ${title}`,
    line,
    `  ${"".padEnd(PAD)}${"REFUSED".padEnd(width + 4)}SETTLED`,
    "",
    ...rows.map((r) => `  ${r.label.padEnd(PAD)}${r.refused.padEnd(width + 4)}${r.settled}`),
    line,
    ...footer.map((f) => `  ${f}`),
  ];
  return out.join("\n");
}

const mark = (result: VerificationResult, name: string): string => {
  const check = result.checks.find((c) => c.name.startsWith(name));
  if (!check) return "—";
  return check.ok ? "✓" : `✗  ${check.detail ?? ""}`.trimEnd();
};

/**
 * Builds the honest receipt for the recorded settlement.
 *
 * Buyer, provider, amount and the accepted intent hash are read back off
 * the chain rather than asserted here, so this script cannot flatter
 * itself by describing a settlement that did not happen. The two fields
 * it cannot recover — the job hash and the task commitment — are marked
 * as such below, and are not what the on-chain check covers.
 */
export async function honestReceipt(algod: Algodv2): Promise<SettlementReceipt> {
  const state = await readState(algod, DEMO.appId);
  const address = (key: string) => encodeAddress(Buffer.from(String(state[key]), "base64"));
  return {
    schema: "closeout-settlement-receipt/v1",
    jobId: "demo_two_agents",
    jobHash: "not re-derivable from the chain",
    state: "released",
    buyer: address("buyer"),
    provider: address("provider"),
    assetId: DEMO.assetId,
    amount: String(state.amount),
    taskCommitment: "not re-derivable from the chain",
    settlementIntentHash: Buffer.from(String(state.acceptedIntent), "base64").toString("hex"),
    fundingTxId: DEMO.fundingTxId,
    settlementTxId: DEMO.settlementTxId,
    issuedAt: new Date().toISOString(),
  };
}

async function main() {
  const algod = new Algodv2("", process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud", "");

  const settled = await honestReceipt(algod);
  // One field. The provider bills ten times the budget that was funded,
  // and changes nothing else — not the parties, not the asset, not the
  // intent hash the buyer accepted.
  const refused: SettlementReceipt = { ...settled, amount: "250000" };

  const [refusedResult, settledResult] = await Promise.all([
    verifyReceiptOnChain(algod, DEMO.appId, refused),
    verifyReceiptOnChain(algod, DEMO.appId, settled),
  ]);

  if (settledResult.ok !== true || refusedResult.ok !== false) {
    console.error("The frame did not hold. Refusing to print a picture that is not true.");
    console.error(JSON.stringify({ refused: refusedResult, settled: settledResult }, null, 2));
    process.exit(1);
  }

  console.log(
    renderFrame(
      `Escrow ${DEMO.appId} on Algorand TestNet — the same settlement, two receipts`,
      [
        { label: "receipt amount", refused: `${refused.amount}  ← one field`, settled: settled.amount },
        { label: "parties, asset, intent", refused: "identical", settled: "identical" },
        { label: "escrow is released", refused: mark(refusedResult, "escrow is"), settled: mark(settledResult, "escrow is") },
        { label: "amount matches", refused: mark(refusedResult, "amount"), settled: mark(settledResult, "amount") },
        { label: "intent matches", refused: mark(refusedResult, "settlement intent"), settled: mark(settledResult, "settlement intent") },
        { label: "", refused: "", settled: "" },
        { label: "verdict", refused: "REFUSED", settled: "VERIFIED" },
      ],
      [
        "Read from a public node. No Closeout API, no key, no funds.",
        "What this establishes: the escrow reached this state, for this amount,",
        "against the intent the buyer accepted. What it cannot establish: that",
        "the delivery was any good. No settlement record can — see THREAT-MODEL.md.",
      ],
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
