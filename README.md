# Closeout

**Verifiable settlement for agent work on Algorand.** One agent pays
another for completed work, and the record proves what was agreed,
delivered, accepted and paid — checkable by someone who does not trust
whoever handed them the receipt.

x402 handles pay-for-response well. It is not a delivery record. Closeout
is the layer above it: a buyer and a provider who agreed on a task, a
budget and an acceptance rule, and a settlement anyone can verify
afterwards.

> **Status: MVP, TestNet only. The contract has not been independently
> reviewed and nothing is deployed to MainNet.** See
> [DEPLOY.md](DEPLOY.md).

## The rules

- Terms are immutable once configured: buyer, provider, asset, amount, expiry.
- Only the named actor may act at each step.
- Money leaves the escrow **at most once**. A released job cannot be
  refunded; a refunded job cannot be released.
- **Acceptance is one-way** — a buyer cannot accept a delivery and then
  reclaim payment by waiting out the expiry.
- **Either party may submit the release** once acceptance is recorded, so
  a buyer who accepts and goes quiet cannot strand the funds.
- The payout is **bound to the settlement intent the buyer accepted**, so
  an API that accepts one agreement and releases against another is
  distinguishable on chain.
- Uncertainty resolves to the buyer. Unclear delivery, a failed verifier,
  or a failed payout never creates a provider payment.

The contract and the off-chain state machine enforce the same rules. A
divergence would mean the API reporting a settlement the chain refuses to
perform — which is the one thing this product claims not to do.

## Reviewing this

The contract is one file:
[`packages/closeout-contract/smart_contracts/closeout_escrow/contract.algo.ts`](packages/closeout-contract/smart_contracts/closeout_escrow/contract.algo.ts)
(155 lines, compiled TEAL alongside it). **Independent review is the
thing this project most needs** — the tests were written by the same
process that wrote the contract, which is exactly when a test suite is
least persuasive.

- [THREAT-MODEL.md](THREAT-MODEL.md) — what is defended, against whom,
  and where it is weak. Written to be argued with.
- [TESTNET-RUN.md](TESTNET-RUN.md) — real transaction ids for both
  settlement paths and a two-agent job.
- [DEPLOY.md](DEPLOY.md) — why this is not on MainNet yet.
- Transition table: `packages/closeout-contract/test/` — every illegal
  transition refused, per-actor authorization, value conservation.

If you find something wrong, an issue saying so is more valuable than
anything else you could send.

## Verify a settlement yourself

Receipts are checked against the chain, using a public node and no
Closeout API:

```bash
cd packages/closeout-client
npx tsx scripts/verify-testnet-receipts.ts
```

That script checks honest receipts for a released and a refunded job from
[TESTNET-RUN.md](TESTNET-RUN.md), and three forgeries — an inflated
amount, a substituted settlement intent, and a released receipt pointed at
the refunded escrow. The forgeries are rejected.

## Layout

| | |
|---|---|
| `packages/closeout-core` | state machine, commitments, receipts |
| `packages/closeout-contract` | the escrow application and its transition table |
| `packages/closeout-client` | lifecycle SDK, on-chain receipt verification, optional pre-sign check |
| `apps/api` | jobs, receipts, paid `POST /jobs`, durable storage |
| `apps/console` | the job timeline, as a page |
| `apps/demo-agents` | two agents transacting over a real job |

## Run

```bash
pnpm install
pnpm -r test        # 95 tests
pnpm -r typecheck
```

TestNet rehearsal and the two-agent demo each need a funded TestNet
account; both print the address and the faucet URL if it is short.

```bash
DEPLOYER_MNEMONIC="…" pnpm --filter @closeout/client e2e
DEPLOYER_MNEMONIC="…" pnpm --filter @closeout/demo-agents demo
```

## What a receipt does not say

It does not say the delivery was good, useful, safe, or legally complete.
It says what was agreed, delivered, accepted and paid. No settlement
record can do more.
