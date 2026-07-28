import { createHash } from "node:crypto";
import {
  assignGroupID,
  encodeUint64,
  getApplicationAddress,
  makeApplicationNoOpTxnFromObject,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  type SuggestedParams,
  type Transaction,
} from "algosdk";
import type { Job } from "@closeout/core";

export const CLOSEOUT_METHODS = {
  fund: "fund",
  deliver: "deliver",
  accept: "accept",
  release: "release",
  refund: "refund",
} as const;

export interface CloseoutAppConfig {
  appId: number;
  usdcAssetId: number;
}

export interface FundingGroup {
  jobHash: Uint8Array;
  appAddress: string;
  transactions: Transaction[];
}

const encoder = new TextEncoder();

export function jobHash(job: Pick<Job, "id" | "buyer" | "provider" | "assetId" | "amount" | "expiresAtRound">): Uint8Array {
  const body = [job.id, job.buyer, job.provider, job.assetId, job.amount, job.expiresAtRound].join("\u001f");
  return createHash("sha256").update(body).digest();
}

/**
 * Produces the two-transaction group the eventual Closeout application must accept:
 * a USDC transfer into the application address immediately followed by `fund`.
 *
 * @deprecated Superseded by `fundJob` in `@closeout/client`, and **this
 * version cannot work against the deployed contract**. It was written
 * before the contract existed and encodes the call three ways the ARC-4
 * application will reject: the app argument is the bare method name
 * rather than the 4-byte selector, `fund(axfer)void` takes no commitment
 * or expiry arguments, and `CLOSEOUT_METHODS` names two methods —
 * `deliver` and `accept` — that the contract does not have; they are
 * `markDelivered` and `markAccepted`.
 *
 * Kept only so its `jobHash` commitment stays available. Every failure
 * above surfaces on chain and nowhere else, which is why
 * `@closeout/client` cross-checks its signatures against the compiled
 * ARC-56 artifact in a test.
 */
export function prepareFundingGroup(
  job: Job,
  config: CloseoutAppConfig,
  suggestedParams: SuggestedParams,
): FundingGroup {
  if (job.state !== "draft") throw new Error("Only a draft job can produce a funding group");
  if (job.assetId !== config.usdcAssetId) throw new Error("Job asset does not match configured USDC asset");
  if (!Number.isInteger(config.appId) || config.appId < 1) throw new Error("appId must be a positive integer");

  const appAddress = getApplicationAddress(config.appId).toString();
  const commitment = jobHash(job);
  const payment = makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: job.buyer,
    receiver: appAddress,
    amount: BigInt(job.amount),
    assetIndex: BigInt(job.assetId),
    suggestedParams,
  });
  const call = makeApplicationNoOpTxnFromObject({
    sender: job.buyer,
    appIndex: BigInt(config.appId),
    appArgs: [encoder.encode(CLOSEOUT_METHODS.fund), commitment, encodeUint64(job.expiresAtRound)],
    accounts: [job.provider],
    foreignAssets: [BigInt(job.assetId)],
    suggestedParams,
  });

  return { jobHash: commitment, appAddress, transactions: assignGroupID([payment, call]) };
}
