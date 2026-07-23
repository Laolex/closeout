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

## Run

```bash
pnpm install
pnpm test
pnpm typecheck
```

This repository is a fresh implementation. It does not reuse Arc showcase code.
