# MainNet deployment — not done, and why

Build order step 8 is *"deploy only after contract review, testnet
rehearsal, and explicit operator approval."* One of those three is met.
This file states the gate rather than quietly stepping over it, because
the thing being deployed holds other people's money.

## Met

- **TestNet rehearsal.** Both settlement paths and a two-agent job, with
  real transaction ids — see [TESTNET-RUN.md](TESTNET-RUN.md).
- 90 tests, including the full transition table: every illegal
  transition refused, per-actor authorization, value conservation, and
  on-chain verification of receipts.

## Not met

- **Independent contract review.** Nobody outside this repository has
  read `CloseoutEscrow`. The tests were written by the same process that
  wrote the contract, which is exactly the case where a test suite is
  least persuasive. Until then the honest description is *an MVP contract
  with documented limits*, never *audited*.
- **Explicit operator approval.** A human decision, not a task to
  complete.
- **Funded MainNet accounts.** The escrow needs ALGO for its minimum
  balance, and `POST /jobs` needs a payout account opted into USDC. No
  faucet exists for MainNet.

## The paid endpoint has never taken a real payment

`POST /jobs` implements the x402 flow and is tested against a stubbed
facilitator: requirements on an unpaid request, verify-then-settle
ordering, no settlement for a malformed job, 502 rather than 200 on a
settlement failure, and a replay that returns the work without charging
twice.

That is not the same as having worked. The live GoPlausible facilitator
has a shape a spec reading does not predict — `/verify` answers HTTP 200
with `isValid: false`, networks are CAIP-2, it speaks x402 v2, and it
wants the decoded payment payload rather than the header — and every one
of those was found by a request failing, not by reading. Assume the first
real payment will teach us something too.

## Before deploying

1. Get the contract read by someone who did not write it.
2. Fund the MainNet accounts and opt the payout account into USDC — a
   transfer to an account that has not opted in **fails**, so every
   payment would bounce.
3. Re-run the TestNet rehearsal against the exact commit being deployed.
4. Deploy one job's escrow first and settle it with a real, small amount.
5. Record the application id, the deployed commit, and the rollback
   position before taking any third-party traffic.

Publish the contract source, ABI, application id and threat model before
inviting anyone else to use it.
