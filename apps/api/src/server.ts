/**
 * The Closeout API as a running service.
 *
 * Configuration is read from the environment, and the service **refuses
 * to start** rather than starting in a half-configured state: a paid
 * endpoint that silently runs unpaid, or with in-memory storage, is
 * worse than one that does not come up.
 *
 *   PORT=8893 PAY_TO=… PUBLIC_BASE_URL=https://… DATA_DIR=/var/lib/closeout \
 *     pnpm --filter @closeout/api start
 *
 * Omit PAY_TO to run free and unscored, which is the right mode for a
 * local prototype.
 */
import { serve } from "@hono/node-server";

import { createCloseoutApp } from "./app.js";
import { createFileJobStore, createFilePaidStore } from "./durable.js";
import { httpFacilitator } from "./payment.js";

const PORT = Number(process.env.PORT ?? 8893);
const DATA_DIR = process.env.DATA_DIR;
const PAY_TO = process.env.PAY_TO;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const PRICE = process.env.JOB_PRICE ?? "10000"; // 0.01 USDC
const FEE_PAYER = process.env.FEE_PAYER;

function fail(message: string): never {
  console.error(`refusing to start: ${message}`);
  process.exit(1);
}

const paid = Boolean(PAY_TO);
if (paid && !PUBLIC_BASE_URL) {
  // `resource` is published as an absolute URL: it is what the
  // facilitator's catalog lists and what an agent dereferences. A bare
  // path names a different endpoint on every host that serves it.
  fail("PAY_TO is set but PUBLIC_BASE_URL is not — the published resource would name no host");
}
if (paid && !DATA_DIR) {
  // In-memory stores lose the idempotency record on restart, and the
  // same payment settles twice.
  fail("PAY_TO is set but DATA_DIR is not — a paid endpoint needs durable storage");
}

const store = DATA_DIR ? createFileJobStore(`${DATA_DIR}/jobs.log`) : undefined;
const paidStore = DATA_DIR ? createFilePaidStore(`${DATA_DIR}/paid.log`) : undefined;

const app = createCloseoutApp({
  store,
  paidStore,
  payment: PAY_TO
    ? {
        payTo: PAY_TO,
        baseUrl: PUBLIC_BASE_URL!,
        price: PRICE,
        feePayer: FEE_PAYER,
        facilitator: httpFacilitator(FACILITATOR_URL),
      }
    : undefined,
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`closeout api on :${info.port}`);
  console.log(paid ? `  paid: ${PRICE} base units to ${PAY_TO}` : "  free: no PAY_TO configured");
  console.log(paid ? `  resource: ${PUBLIC_BASE_URL}/jobs` : "");
  console.log(DATA_DIR ? `  storage: ${DATA_DIR}` : "  storage: in-memory (not for payments)");
});
