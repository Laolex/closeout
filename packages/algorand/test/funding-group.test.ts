import assert from "node:assert/strict";
import test from "node:test";
import { createJob } from "@closeout/core";
import { decodeAddress, encodeAddress, type SuggestedParams } from "algosdk";
import { CLOSEOUT_METHODS, prepareFundingGroup } from "../src/index.js";

const buyer = "MO2H6ZU47Q36GJ6GVHUKGEBEQINN7ZWVACMWZQGIYUOE3RBSRVYHV4ACJI";
const provider = "7777777777777777777777777777777777777777777777777774MSJUVU";
const params: SuggestedParams = {
  fee: 1000,
  minFee: 1000,
  firstValid: 1,
  lastValid: 1000,
  genesisID: "mainnet-v1.0",
  genesisHash: new Uint8Array(32),
  flatFee: true,
};

const job = () => createJob({
  id: "job_01",
  buyer,
  provider,
  assetId: 31566704,
  amount: "100000",
  expiresAtRound: 500,
  deliveryMode: "buyer_accepts",
  taskCommitment: "b".repeat(64),
});

test("funding group transfers exact USDC then calls the expected app", () => {
  const prepared = prepareFundingGroup(job(), { appId: 77, usdcAssetId: 31566704 }, params);
  const [payment, call] = prepared.transactions;

  assert.equal(prepared.transactions.length, 2);
  assert.equal(payment.type, "axfer");
  assert.equal(payment.assetTransfer?.assetIndex, 31566704n);
  assert.equal(payment.assetTransfer?.amount, 100000n);
  assert.equal(encodeAddress(payment.assetTransfer?.receiver.publicKey ?? new Uint8Array()), prepared.appAddress);
  assert.equal(call.type, "appl");
  assert.equal(call.applicationCall?.appIndex, 77n);
  assert.equal(call.applicationCall?.appArgs?.[0] && new TextDecoder().decode(call.applicationCall.appArgs[0]), CLOSEOUT_METHODS.fund);
  assert.deepEqual(call.applicationCall?.appArgs?.[1], prepared.jobHash);
  assert.equal(call.group?.length, 32);
  assert.deepEqual(payment.group, call.group);
  assert.equal(encodeAddress(call.applicationCall?.accounts?.[0].publicKey ?? decodeAddress(provider).publicKey), provider);
});

test("does not prepare a group for a different asset", () => {
  const wrongAssetJob = createJob({ ...job(), assetId: 1 });
  assert.throws(() => prepareFundingGroup(wrongAssetJob, { appId: 77, usdcAssetId: 31566704 }, params));
});
