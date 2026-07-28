# Threat model

What Closeout protects, from whom, and where it is still weak. Written to
be argued with — if something here is wrong, that is the most useful thing
you can tell us.

The system is a single-job escrow on Algorand (`CloseoutEscrow`), an
off-chain state machine that mirrors it (`@closeout/core`), an API that
records jobs and issues receipts, and a client that builds the
transactions.

## What is at risk

**The job budget.** One fixed amount of one ASA, held by the application
account between funding and settlement. That is the only value the system
custodies, and only for the life of one job.

**The truthfulness of the record.** A settlement receipt asserts what was
agreed, delivered, accepted and paid. A record that can be forged is worse
than no record, because it will be believed.

Not at risk, because the system never holds them: private keys, the task
text, the delivery content.

## Who we defend against

| Actor | Assumed to |
|---|---|
| The buyer | Try to get work without paying, or reclaim payment after accepting |
| The provider | Try to get paid without delivering, or for a different job |
| A third party | Try to move funds, or forge a receipt about someone else's job |
| **The Closeout operator (us)** | Be compromised, buggy, or dishonest |
| The node / indexer | Be unavailable, or return stale data |

The fourth row is the important one. If the guarantees only hold when we
behave, the product is an invoice with extra steps.

## What the contract enforces

These hold regardless of what the API says, and each is covered by a test
in `packages/closeout-contract/test`:

- **Terms are immutable once configured.** Buyer, provider, asset, amount
  and expiry are written once. `configure` cannot be replayed.
- **Only the named actor may act.** The buyer funds, accepts and refunds;
  only the provider may mark delivery; either party may submit the release
  once acceptance is recorded; nobody else may do anything.
- **The funding group must match exactly** — sender, receiver, asset and
  amount. An overpayment is refused rather than stranded in the
  application account.
- **Money leaves once.** Release and refund are each reachable once, a
  released job cannot be refunded, and a refunded job cannot be released.
- **Acceptance is one-way.** A buyer cannot accept and then reclaim the
  payment by waiting out the expiry.
- **The payout is bound to the accepted intent.** `release` must carry the
  hash the buyer committed to at acceptance, so an API that accepts one
  settlement and releases against another is distinguishable on chain.
- **Refund requires expiry.** Uncertainty resolves to the buyer; a
  recorded acceptance resolves to the provider.
- **No administrator key.** There is no path that bypasses any of the
  above.

## Attacks considered

**A dishonest operator issues a false receipt.** Mitigated:
`verifyReceiptOnChain` reads the escrow's global state from any public
node and checks state, amount and accepted intent. It calls no Closeout
API. Demonstrated against real TestNet settlements — an inflated amount, a
substituted intent, and a released receipt pointed at a refunded escrow
are all rejected.

**A compromised API releases against a different agreement.** Mitigated by
the on-chain intent binding above. The API cannot substitute an intent
between acceptance and release.

**A buyer accepts, then reclaims the money.** Mitigated: refund is
reachable only from `funded | delivered`.

**A buyer accepts, then disappears.** Mitigated: the provider may submit
the release itself.

**A provider delivers nothing.** Mitigated by expiry: without acceptance,
the budget returns to the buyer. The system never converts uncertainty
into a payout.

**A caller pays and is charged twice.** Mitigated: the paid-nonce record
is durable, so a replay after a restart returns the job without settling
again. Settlement is last, so an unanswerable request is never charged.

**A settlement failure leaves the endpoint free.** Mitigated: a failed
settle is a 502 with the record pending, never a 200 with the work
attached.

**Task or delivery content leaks.** Mitigated: only commitments are
stored on chain, in receipts, and on the console page. Tests assert the
delivery URI reaches none of them.

**A malicious job value attacks a reader.** Mitigated: the console escapes
all job-supplied text and loads no script.

## Where it is weak

- **The contract has had no independent review.** The tests were written
  by the same process that wrote the contract, which is exactly when a
  suite is least persuasive. Until that changes: an MVP contract with
  documented limits, never "audited".
- **The paid endpoint has never taken a real payment.** It is tested
  against a stubbed facilitator. Every surprise in the live facilitator so
  far was found by a request failing, not by reading a spec.
- **Delivery URIs are never fetched, and must not be** without SSRF
  controls. Nothing fetches one today; the first thing that does is the
  next place to look for a hole.
- **One escrow per job.** Deployment cost per job is real, and a
  multi-job, box-backed application would change the authorization
  surface materially. Treat this document as scoped to the single-job
  design.
- **Expiry is a round number, not a wall clock.** A caller choosing an
  expiry needs to reason in rounds; too tight an expiry is a way to
  pressure a provider.
- **Availability is not solved.** If the API is down, a job in flight can
  still be driven directly against the contract by both parties, but
  nothing automates that today.

## What a receipt does not say

It does not say the delivery was good, useful, safe, or legally complete.
It says what was agreed, delivered, accepted and paid. No settlement
record can do more, and any product claiming otherwise is describing a
model's opinion as a fact.
