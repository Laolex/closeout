# Closeout

Verifiable settlement for agent work on Algorand.

The first prototype is payment-free. It defines the settlement state machine before the contract, HTTP API, or x402 fee path.

It supports one buyer, one provider, one fixed USDC amount, one delivery, and one release or refund.

## Rules

- A release binds to one immutable settlement intent.
- The intent fixes the job, buyer, provider, asset, amount, nonce, and expiry.
- Any mismatch blocks release.
- Unclear delivery or a failed payout never creates a provider payment.
- An unresolved job becomes refundable only after expiry.
- Acceptance is one-way. A buyer cannot accept a delivery and then reclaim
  the payment by waiting out the expiry.
- Either party may submit the release once acceptance is recorded, so a
  buyer who accepts and goes quiet cannot strand the funds.

Together those last two are the property worth checking: money leaves the
escrow at most once, in the direction the recorded decisions point, and
neither party can freeze the other. The contract and the off-chain state
machine enforce the same rules — a divergence would mean the API reporting
a settlement the chain refuses to perform.

## Run

```bash
pnpm install
pnpm test
pnpm typecheck
```

This repository is a fresh implementation. It does not reuse Arc showcase code.
