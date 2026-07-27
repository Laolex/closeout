import { expect, test } from 'vitest'

import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { Uint64 } from '@algorandfoundation/algorand-typescript'

import { CloseoutEscrow } from '../smart_contracts/closeout_escrow/contract.algo'

const AMOUNT = Uint64(10_000)
const EXPIRY = Uint64(500)

function setup() {
  const ctx = new TestExecutionContext()
  const escrow = ctx.contract.create(CloseoutEscrow)
  const buyer = ctx.any.account()
  const provider = ctx.any.account()
  const usdc = ctx.any.asset()
  const call = ctx.any.txn.applicationCall({
    sender: buyer,
    appId: escrow,
    fee: Uint64(2_000),
  })

  ctx.txn.createScope([call]).execute(() => {
    escrow.configure(buyer, provider, usdc, AMOUNT, EXPIRY)
  })

  return { buyer, ctx, escrow, provider, usdc }
}

test('configures immutable buyer, provider, asset, amount, and expiry', () => {
  const { escrow } = setup()

  expect(escrow.state.value).toEqual(Uint64(1))
  expect(escrow.amount.value).toEqual(AMOUNT)
  expect(escrow.expiresAtRound.value).toEqual(EXPIRY)
})
