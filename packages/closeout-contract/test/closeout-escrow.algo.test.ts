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

/** Drives a job to `accepted`. */
function accepted() {
  const job = delivered()
  call(job.buyer, job.escrow, () => job.escrow.markAccepted())
  return job
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

    call(job.buyer, job.escrow, () => job.escrow.markAccepted())
    expect(job.escrow.state.value).toEqual(S.accepted)

    call(job.buyer, job.escrow, () => job.escrow.release())
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
    expect(() => call(job.provider, job.escrow, () => job.escrow.markAccepted())).toThrow(
      /Only the buyer may accept/,
    )
  })

  test('the provider cannot release funds to themselves', () => {
    const job = accepted()
    expect(() => call(job.provider, job.escrow, () => job.escrow.release())).toThrow(/Only the buyer may release/)
  })

  test('a stranger cannot release or refund', () => {
    const job = accepted()
    expect(() => call(job.stranger, job.escrow, () => job.escrow.release())).toThrow(/Only the buyer may release/)

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
    expect(() => call(job.buyer, job.escrow, () => job.escrow.markAccepted())).toThrow(/no delivery/)
    expect(() => call(job.buyer, job.escrow, () => job.escrow.release())).toThrow(/not accepted/)
  })

  test('funds cannot be released before delivery or acceptance', () => {
    const funded_ = funded()
    expect(() => call(funded_.buyer, funded_.escrow, () => funded_.escrow.release())).toThrow(/not accepted/)

    const delivered_ = delivered()
    expect(() => call(delivered_.buyer, delivered_.escrow, () => delivered_.escrow.release())).toThrow(
      /not accepted/,
    )
  })

  test('acceptance cannot skip delivery', () => {
    const job = funded()
    expect(() => call(job.buyer, job.escrow, () => job.escrow.markAccepted())).toThrow(/no delivery/)
  })

  test('a job cannot be funded twice', () => {
    const job = funded()
    expect(() => fundWith(job)).toThrow(/not awaiting funding/)
  })
})

describe('value conservation: the escrow pays out exactly once', () => {
  test('release cannot be replayed', () => {
    const job = accepted()
    call(job.buyer, job.escrow, () => job.escrow.release())

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release())).toThrow(/not accepted/)
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
    call(job.buyer, job.escrow, () => job.escrow.release())
    expire()

    expect(() => call(job.buyer, job.escrow, () => job.escrow.refund())).toThrow(/not refundable/)
  })

  test('a refunded job cannot then be released', () => {
    const job = funded()
    expire()
    call(job.buyer, job.escrow, () => job.escrow.refund())

    expect(() => call(job.buyer, job.escrow, () => job.escrow.release())).toThrow(/not accepted/)
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

  test('KNOWN GAP: an ACCEPTED job can still be refunded to the buyer after expiry', () => {
    // This documents current behaviour, and it contradicts the spec's
    // state machine, which allows a refund only from `funded | delivered`
    // and sends `accepted` to `released`.
    //
    // As written, a buyer can accept a delivery, decline to release, wait
    // for expiry, and take the money back — for work they have already
    // signed an acceptance for. The provider cannot release on their own
    // (`Only the buyer may release`), so they have no counter-move.
    //
    // Removing state 4 from the refundable set is not sufficient on its
    // own: a buyer who accepts and then disappears would strand the funds
    // forever. The two changes belong together — refund limited to
    // funded|delivered, and release callable by the provider once
    // acceptance is recorded. Both are settlement-semantics decisions, so
    // this is left failing-by-documentation rather than silently changed.
    const job = accepted()
    expire()

    call(job.buyer, job.escrow, () => job.escrow.refund())
    expect(job.escrow.state.value).toEqual(S.refunded)
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
