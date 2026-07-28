import { Algodv2 } from "algosdk";

import { deriveFindings, type ControlSurfaceReport, type TaskRequest } from "./task.ts";

/**
 * The provider agent.
 *
 * It does the actual work of the job: read the asset's parameters from a
 * node and report who, other than the holder, has power over a holding.
 * The data is real and public — the value the buyer is paying for is that
 * someone else went and got it, in the exact shape they agreed to accept.
 */
export async function produceReport(algod: Algodv2, request: TaskRequest): Promise<ControlSurfaceReport> {
  const asset = await algod.getAssetByID(BigInt(request.assetId)).do();
  const p = asset.params;
  if (!p) throw new Error(`Asset ${request.assetId} has no parameters — it may not exist on this network`);

  // An unset role comes back as the zero address or as absent, depending
  // on the node. Both mean "nobody holds this power", and reporting the
  // zero address as an authority would be a false finding.
  const address = (value: unknown): string | null => {
    const s = value === undefined || value === null ? null : String(value);
    if (!s || s === ZERO_ADDRESS) return null;
    return s;
  };

  const base: ControlSurfaceReport = {
    schema: "closeout-demo-asset-control/v1",
    assetId: request.assetId,
    unitName: p.unitName ?? "",
    decimals: Number(p.decimals),
    total: String(p.total),
    manager: address(p.manager),
    freeze: address(p.freeze),
    clawback: address(p.clawback),
    reserve: address(p.reserve),
    defaultFrozen: Boolean(p.defaultFrozen),
    findings: [],
  };

  return { ...base, findings: deriveFindings(base) };
}

export const ZERO_ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
