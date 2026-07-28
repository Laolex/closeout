import {
  Contract,
  Global,
  GlobalState,
  Txn,
  Uint64,
  assert,
  contract,
  gtxn,
  itxn,
} from '@algorandfoundation/algorand-typescript'
import type { Account, Asset, bytes, uint64 } from '@algorandfoundation/algorand-typescript'

/**
 * One fixed-price Closeout job.
 *
 * This contract is deliberately a single-job escrow. It makes the release and
 * refund rules easy to audit before a multi-job box-backed application exists.
 */
@contract({ stateTotals: { globalUints: 4, globalBytes: 3 } })
export class CloseoutEscrow extends Contract {
  public buyer = GlobalState<Account>()
  public provider = GlobalState<Account>()
  public usdc = GlobalState<Asset>()
  public amount = GlobalState<uint64>()
  public expiresAtRound = GlobalState<uint64>()
  public state = GlobalState<uint64>({ initialValue: Uint64(0) })

  /**
   * Hash of the SettlementIntent the buyer signed when accepting.
   *
   * This is what authorizes the payout. The terms themselves — buyer,
   * provider, asset, amount, expiry — are already immutable here, so what
   * the commitment adds is that the release must be the *same* settlement
   * the buyer accepted, nonce included. Without it, an API that accepts
   * one intent and releases against another is indistinguishable on-chain
   * from an honest one.
   */
  public acceptedIntent = GlobalState<bytes>()

  /**
   * Stores the immutable job terms and opts the application into the exact ASA.
   * The deployment client must supply the asset as an app resource and cover the
   * inner transaction fee.
   */
  public configure(
    buyer: Account,
    provider: Account,
    usdc: Asset,
    amount: uint64,
    expiresAtRound: uint64,
  ): void {
    assert(this.state.value === Uint64(0), 'Escrow is already configured')
    assert(Txn.sender === buyer, 'Only the buyer may configure this escrow')
    assert(amount > Uint64(0), 'Amount must be positive')
    assert(expiresAtRound > Uint64(0), 'Expiry must be positive')
    this.buyer.value = buyer
    this.provider.value = provider
    this.usdc.value = usdc
    this.amount.value = amount
    this.expiresAtRound.value = expiresAtRound
    itxn
      .assetTransfer({
        assetReceiver: Global.currentApplicationAddress,
        xferAsset: usdc,
        assetAmount: Uint64(0),
        fee: Uint64(0),
      })
      .submit()
    this.state.value = Uint64(1)
  }

  /** Accepts only the exact USDC transfer grouped with this application call. */
  public fund(payment: gtxn.AssetTransferTxn): void {
    assert(this.state.value === Uint64(1), 'Escrow is not awaiting funding')
    assert(Txn.sender === this.buyer.value, 'Only the buyer may fund')
    assert(payment.sender === this.buyer.value, 'Funding sender does not match buyer')
    assert(payment.assetReceiver === Global.currentApplicationAddress, 'Funding must target this escrow')
    assert(payment.xferAsset === this.usdc.value, 'Funding asset does not match')
    assert(payment.assetAmount === this.amount.value, 'Funding amount does not match')
    this.state.value = Uint64(2)
  }

  /** Records that the named provider submitted a delivery commitment off-chain. */
  public markDelivered(): void {
    assert(this.state.value === Uint64(2), 'Escrow is not funded')
    assert(Txn.sender === this.provider.value, 'Only the provider may mark delivery')
    this.state.value = Uint64(3)
  }

  /**
   * Marks the delivery accepted, committing to the settlement intent that
   * will authorize the payout. Release stays a separate transition.
   */
  public markAccepted(intentHash: bytes): void {
    assert(this.state.value === Uint64(3), 'Escrow has no delivery')
    assert(Txn.sender === this.buyer.value, 'Only the buyer may accept delivery')
    assert(intentHash.length === Uint64(32), 'Settlement intent hash must be 32 bytes')
    this.acceptedIntent.value = intentHash
    this.state.value = Uint64(4)
  }

  /**
   * Releases the exact funded amount once, and only after buyer acceptance.
   *
   * Either party may submit it. Acceptance is already the buyer's
   * authorization to pay, so the transfer is not a second discretionary
   * decision — and leaving it buyer-only would let a buyer who accepts and
   * then goes quiet strand the funds against a delivery they signed off,
   * with the provider holding no move of their own.
   */
  public release(intentHash: bytes): void {
    assert(this.state.value === Uint64(4), 'Escrow is not accepted')
    assert(
      Txn.sender === this.buyer.value || Txn.sender === this.provider.value,
      'Only the buyer or provider may release',
    )
    assert(intentHash === this.acceptedIntent.value, 'Settlement does not match the accepted intent')
    itxn
      .assetTransfer({
        assetReceiver: this.provider.value,
        xferAsset: this.usdc.value,
        assetAmount: this.amount.value,
        fee: Uint64(0),
      })
      .submit()
    this.state.value = Uint64(5)
  }

  /**
   * Returns funds to the buyer when an *unresolved* job has expired.
   *
   * Funded and delivered are unresolved; accepted is not. Acceptance is
   * one-way, so a buyer cannot accept a delivery, sit out the expiry and
   * claw back payment for work they already signed off. Uncertainty
   * resolves to the buyer; a recorded acceptance resolves to the provider.
   */
  public refund(): void {
    assert(
      this.state.value === Uint64(2) || this.state.value === Uint64(3),
      'Escrow is not refundable',
    )
    assert(Txn.sender === this.buyer.value, 'Only the buyer may refund')
    assert(Global.round > this.expiresAtRound.value, 'Escrow has not expired')
    itxn
      .assetTransfer({
        assetReceiver: this.buyer.value,
        xferAsset: this.usdc.value,
        assetAmount: this.amount.value,
        fee: Uint64(0),
      })
      .submit()
    this.state.value = Uint64(6)
  }
}
