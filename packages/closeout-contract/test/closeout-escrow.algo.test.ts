import { beforeEach, describe, expect, test } from 'vitest'

import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint64 } from '@algorandfoundation/algorand-typescript'

import { CloseoutEscrow } from '../smart_contracts/closeout_escrow/contract.algo'

const AMOUNT = Uint64(10_000)
const EXPIRY = Uint64(500)

/**
 * The escrow's state is a uint64, so the transition table reads as
 * numbers on-chain. Naming them keeps the tests about the workflow
 * rather than about magic constants.
 */
const S = {
  unconfigured: Uint64(0),
  awaitingFunding: Uint64(1),
  funded: Uint64(2),
  delivered: Uint64(3),
  accepted: Uint64(4),
  released: Uint64(5),
  refunded: Uint64(6),
} as const

/**
 * The execution context is a process-wide singleton — constructing a
 * second one throws `Execution context has already been set`. So it is
 * built once and reset between tests, which clears ledger state, global
 * state and accounts just the same.
 */
const ctx = new TestExecutionContext()

beforeEach(() => {
  ctx.reset()
})

/** Configures a job and returns its participants. */
function configured() {
  const escrow = ctx.contract.create(CloseoutEscrow)
  const buyer = ctx.any.account()
  const provider = ctx.any.account()
  const stranger = ctx.any.account()
  const usdc = ctx.any.asset()

  call(buyer, escrow, () => escrow.configure(buyer, provider, usdc, AMOUNT, EXPIRY))

  return { buyer, escrow, provider, stranger, usdc }
}

/** Runs `body` as an application call sent by `sender`. */
function call(sender: ReturnType<TestExecutionContext['any']['account']>, escrow: CloseoutEscrow, body: () => void) {
  const appCall = ctx.any.txn.applicationCall({ sender, appId: escrow, fee: Uint64(2_000) })
  ctx.txn.createScope([appCall]).execute(body)
}

/**
 * Funds the escrow with a correctly-formed grouped transfer. Individual
 * fields are overridable so the malformed-group tests can vary exactly
 * one thing at a time.
 */
function fundWith(
  job: ReturnType<typeof configured>,
  overrides: { sender?: unknown; receiver?: unknown; asset?: unknown; amount?: unknown } = {},
) {
  const { buyer, escrow, usdc } = job
  // The contract compares against Global.currentApplicationAddress, which
  // is the *application's* account — not the contract object.
  const escrowAddress = ctx.ledger.getApplicationForContract(escrow).address
  const transfer = ctx.any.txn.assetTransfer({
    sender: (overrides.sender ?? buyer) as never,
    assetReceiver: (overrides.receiver ?? escrowAddress) as never,
    xferAsset: (overrides.asset ?? usdc) as never,
    assetAmount: (overrides.amount ?? AMOUNT) as never,
  })
  const appCall = ctx.any.txn.applicationCall({ sender: buyer, appId: escrow, fee: Uint64(2_000) })
  ctx.txn.createScope([transfer, appCall], 1).execute(() => escrow.fund(transfer))
}

/** Drives a job to `funded`. */
function funded() {
  const job = configured()
  fundWith(job)
  return job
}

/** Drives a job to `delivered`. */
function delivered() {
  const job = funded()
  call(job.provider, job.escrow, () => job.escrow.markDelivered())
  return job
}

/**
 * The hash of the SettlementIntent the buyer signed. On-chain this is
 * the commitment that authorizes the payout — the API cannot substitute
 * a different one between acceptance and release.
 */
function intentHash() {
  return ctx.any.bytes(32)
}

/** Drives a job to `accepted`, committing to a settlement intent. */
function accepted(intent = intentHash()) {
  const job = delivered()
  call(job.buyer, job.escrow, () => job.escrow.markAccepted(intent))
  return { ...job, intent }
}

/** Moves the ledger past the job's expiry round. */
function expire() {
  ctx.ledger.patchGlobalData({ round: Uint64(EXPIRY.valueOf() + 1) })
}

describe("the happy path each transition is meant to allow", () => {
  test('configure stores immutable terms and awaits funding', () => {
    const { escrow } = configured()

    expect(escrow.state.value).toEqual(S.awaitingFunding)
    expect(escrow.amount.value).toEqual(AMOUNT)
    expect(escrow.expiresAtRound.value).toEqual(EXPIRY)
  })

  test('fund, deliver, accept, release runs end to end', () => {
    const job = funded()
    expect(job.escrow.state.value).toEqual(S.funded)

    call(job.provider, job.escrow, () => job.escrow.markDelivered())
    expect(job.escrow.state.value).toEqual(S.delivered)

    const intent = intentHash()
    call(job.buyer, job.escrow, () => job.escrow.markAccepted(intent))
    expect(job.escrow.state.value).toEqual(S.accepted)

    call(job.buyer, job.escrow, () => job.escrow.release(intent))
    expect(job.escrow.state.value).toEqual(S.released)
  })

  test('an expired job refunds the buyer', () => {
    const job = funded()
    expire()

    call(job.buyer, job.escrow, () => job.escrow.refund())
    expect(job.escrow.state.value).toEqual(S.refunded)
  })
})

describe('only the named actor may make each transition', () => {
  test('a stranger cannot configure someone else as buyer', () => {
    const escrow = ctx.contract.create(CloseoutEscrow)
    const buyer = ctx.any.account()
    const provider = ctx.any.account()
    const stranger = ctx.any.account()
    const usdc = ctx.any.asset()

    expect(() =>
      call(stranger, escrow, () => escrow.configure(buyer, provider, usdc, AMOUNT, EXPIRY)),
    ).toThrow(/Only the buyer may configure/)
  })

  test('the provider cannot fund on the buyer’s behalf', () => {
    const job = configured()
    expect(() => fundWith(job, { sender: job.provider })).toThrow(/Funding sender does not match buyer/)
  })

  test('the buyer cannot mark their own delivery', () => {
    const job = funded()
    expect(() => call(job.buyer, job.escrow, () => job.escrow.markDelivered())).toThrow(
      /Only the provider may mark delivery/,
    )
  })

  test('the provider cannot accept their own delivery', () => {
    const job = delivered()
    expect(() => call(job.provider, job.escrow, () => job.escrow.markAccepted(intentHash()))).toThrow(
      /Only the buyer may accept/,
    )
  })

  test('the provider may release once acceptance is recorded', () => {
    // Acceptance is the buyer's authorization to pay. Leaving release
    // buyer-only lets a buyer who accepts and then disappears strand the
    // funds, with the provider holding an accepted delivery and no move.
    const job = accepted()

    call(job.provider, job.escrow, () => job.escrow.release(job.intent))
    expect(job.escrow.state.value).toEqual(S.released)
  })

  test('the provider cannot release before the buyer accepts', () => {
    const job = delivered()
    expect(() => call(job.provider, job.escrow, () => job.escrow.release(intentHash()))).toThrow(/not accepted/)
  })

  test('a stranger cannot release an accepted job', () => {
    const job = accepted()
    expect(() => call(job.stranger, job.escrow, () => job.escrow.release(job.intent))).toThrow(
      /Only the buyer or provider may release/,
    )
  })

  test('a stranger cannot refund a refundable job', () => {
    // Asserted against a *funded* job on purpose. An accepted one is no
    // longer refundable at all, so the state check would fire first and
    // the authorization rule would never be exercised.
    const job = funded()
    expire()

    expect(() => call(job.stranger, job.escrow, () => job.escrow.refund())).toThrow(/Only the buyer may refund/)
  })
})

describe('a malformed funding group moves nothing', () => {
  test('rejects a transfer of the wrong asset', () => {
    const job = configured()
    expect(() => fundWith(job, { asset: ctx.any.asset() })).toThrow(/Funding asset does not match/)
    expect(job.escrow.state.value).toEqual(S.awaitingFunding)
  })

  test('rejects a short payment', () => {
    const job = configured()
    expect(() => fundWith(job, { amount: Uint64(AMOUNT.valueOf() - 1n) })).toThrow(/Funding amount does not match/)
  })

  test('rejects an overpayment, which would otherwise strand the surplus', () => {
    // The release path transfers exactly `amount`, so anything above it
    // would sit in the application account with no rule to move it.
    const job = configured()
    expect(() => fundWith(job, { amount: Uint64(AMOUNT.valueOf() + 1n) })).toThrow(/Funding amount does not match/)
  })

  test('rejects a transfer aimed at someone other than the escrow', () => {
    const job = configured()
    expect(() => fundWith(job, { receiver: job.provider })).toThrow(/Funding must target this escrow/)
  })
})

describe('every out-of-order transition is refused', () => {
  test('configure cannot be replayed to rewrite the terms', () => {
    const job = configured()
    const attacker = ctx.any.account()

    expect(() =>
      call(job.buyer, job.escrow, () => job.escrow.configure(job.buyer, attacker, job.usdc, AMOUNT, EXPIRY)),
    ).toThrow(/already configured/)
    expect(job.escrow.provider.value).toEqual(job.provider)
  })

  test('an unfunded job cannot be delivered, accepted or released', () => {
    const job = configured()

    expect(() => call(job.provider, job.escrow, () => job.escrow.markDelivered())).toThrow(/not funded/)
    expect(() => call(job.buyer, job.escrow, () => job.escrow.markAccepted(intentHash()))).toThrow(/no delivery/)
    expect(() => call(job.buyer, job.escrow, () => job.escrow.release(intentHash()))).toThrow(/not accepted/)
  })

  test('funds cannot be released before delivery or acceptance', () => {
    const funded_ = funded()
    expect(() => call(funded_.buyer, funded_.escrow, () => funded_.escrow.release(intentHash()))).toThrow(/not accepted/)

    const delivered_ = delivered()
    expect(() => call(delivered_.buyer, delivered_.escrow, () => delivered_.escrow.release(intentHash()))).toThrow(
      /not accepted/,
    )
  })

  test('acceptance cannot skip delivery', () => {
    const job = funded()
    expect(() => call(job.buyer, job.escrow, () => job.escrow.markAccepted(intentHash()))).toThrow(/no delivery/)
  })

  test('a job cannot be funded twice', () => {
    const job = funded()
    expect(() => fundWith(job)).toThrow(/not awaiting funding/)
  })
})

describe('the payout is bound to the exact intent the buyer accepted', () => {
  test('release refuses an intent other than the accepted one', () => {
    // This is the claim the product rests on: the *signed intent*
    // authorizes the settlement, not whatever the API says at release
    // time. Without this check, a compromised or buggy API could accept
    // one intent and release against another, and nothing on-chain would
    // notice.
    const job = accepted()

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release(intentHash()))).toThrow(
      /does not match the accepted intent/,
    )
    expect(job.escrow.state.value).toEqual(S.accepted)
  })

  test('the provider cannot substitute their own intent either', () => {
    const job = accepted()

    expect(() => call(job.provider, job.escrow, () => job.escrow.release(intentHash()))).toThrow(
      /does not match the accepted intent/,
    )
  })

  test('acceptance records the intent hash on-chain', () => {
    const job = accepted()
    expect(job.escrow.acceptedIntent.value).toEqual(job.intent)
  })

  test('a rejected release leaves the job releasable against the right intent', () => {
    // A failed attempt must not consume the acceptance.
    const job = accepted()

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release(intentHash()))).toThrow()
    call(job.buyer, job.escrow, () => job.escrow.release(job.intent))
    expect(job.escrow.state.value).toEqual(S.released)
  })
})

describe('value conservation: the escrow pays out exactly once', () => {
  test('release cannot be replayed', () => {
    const job = accepted()
    call(job.buyer, job.escrow, () => job.escrow.release(job.intent))

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release(job.intent))).toThrow(/not accepted/)
    expect(job.escrow.state.value).toEqual(S.released)
  })

  test('refund cannot be replayed', () => {
    const job = funded()
    expire()
    call(job.buyer, job.escrow, () => job.escrow.refund())

    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/not refundable/)
    expect(job.escrow.state.value).toEqual(S.refunded)
  })

  test('a released job cannot then be refunded', () => {
    // Otherwise the buyer is paid back money the provider already has.
    const job = accepted()
    call(job.buyer, job.escrow, () => job.escrow.release(job.intent))
    expire()

    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/not refundable/)
  })

  test('a refunded job cannot then be released', () => {
    const job = funded()
    expire()
    call(job.buyer, job.escrow, () => job.escrow.refund())

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release(job.intent))).toThrow(/not accepted/)
  })
})

describe('refund is gated on expiry, not on impatience', () => {
  test('an unexpired funded job cannot be refunded', () => {
    const job = funded()
    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/has not expired/)
  })

  test('an unexpired delivered job cannot be refunded out from under the provider', () => {
    const job = delivered()
    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/has not expired/)
  })

  test('an accepted job cannot be refunded, however long the buyer waits', () => {
    // Acceptance is one-way. Otherwise a buyer could accept a delivery,
    // decline to release, wait out the expiry and take the money back for
    // work they had already signed off — and the provider, who cannot
    // release without acceptance, would have no counter-move.
    const job = accepted()
    expire()

    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/not refundable/)
    expect(job.escrow.state.value).toEqual(S.accepted)
  })

  test('an accepted job stays releasable to the provider after expiry', () => {
    // The flip side of the rule above: expiry must not become a way to
    // freeze accepted work either.
    const job = accepted()
    expire()

    call(job.provider, job.escrow, () => job.escrow.release(job.intent))
    expect(job.escrow.state.value).toEqual(S.released)
  })

  test('a delivered but unaccepted job refunds after expiry', () => {
    // The documented escape hatch: uncertainty resolves to the buyer, and
    // never silently into a provider payout.
    const job = delivered()
    expire()

    call(job.buyer, job.escrow, () => job.escrow.refund())
    expect(job.escrow.state.value).toEqual(S.refunded)
  })
})
