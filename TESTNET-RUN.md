# TestNet rehearsal

One full job and one expiry-refund, run end to end against Algorand TestNet
on 2026-07-27. Every id below is real and independently checkable — nothing
here is asserted by the runner that was not also read back off the chain.

Reproduce with `DEPLOYER_MNEMONIC="…" pnpm --filter @closeout/client e2e`.

Asset `768201264` (`tUSDC`, 6 decimals) stands in for USDC so the rehearsal
is self-contained. Amount is `10000` base units in both jobs.

## Job 1 — funded, delivered, accepted, released

| Step | Transaction |
|---|---|
| Application | `768201279` |
| Configure | `NBLOM7QLXFDHLAIO5AYEMG3IKOXTRHJFQSYGCZHZ6AFOYCBE4VFQ` |
| Fund (group) | `T5HSXOFEIHLXLTGGRFOZAKUR6IJ6Q3XVVMXJTT6T52VIMFLL7L2Q`, `3T3EAZITB2WVHTHUFMQ56AYT2MN422QP3BRR32733P2L2233BVPQ` |
| Deliver | `APLVNYVWQYXWV74Y2V36WYQWAZRU3G4BXWWX3UG4LDWDN4QVOIUQ` |
| Accept | `XXO33JPLVTYHLUD2NPBCCNNUHRJZVAWCAIX7S2XQJ4DCIGEUDMWA` |
| Release | `F5HOR3E7KJUTGWT3NWW2XOPLH3HG75QMTA4WCXYQZ6T7R2N4ENKA` |

Final state read back from the chain: `state = 5` (released), with the
accepted intent hash still recorded in global state.

**The release was submitted by the provider**
(`XBUWT2ES4MU56BSJNVTNAOGHZXWOS54ZYK246HPJ6ZQ7GGVCR47RIEYLCM`), not the
buyer. That is the either-party rule holding on a live network rather than
in a test double: the buyer's acceptance was the authorization, and the
provider collected on it without needing the buyer to come back.

The release carried one inner transaction — 10,000 units of asset
`768201264` to the provider — and the provider's holding read back as
exactly 10,000.

## Job 2 — funded, left unresolved, refunded after expiry

| Step | Transaction |
|---|---|
| Application | `768201307` |
| Configure | `DRKO6OZ5HN66H3CAIDBUCH44SDR5Y5RAA4KRIK65CECAW4CQGG3Q` |
| Fund (group) | `QZ5ZWJH7U5T2UOWUJBGJUZ6PC3DJLFXARM4P6VAGT4J4O2PMS7TA`, `JV55WCQR2YI75ZIV4OX4MN33GO5NXEAAZT4PTQU3BTP37R5HR35A` |
| Refund | `WH73UOLPBNH3DDNR5BJAS3ESTKMY57YJZUMIIG35GCRMDNFT7Q6Q` |

Expiry was set three rounds out; the refund was submitted only after that
round passed, and the buyer's holding increased by exactly the funded
amount. Final state `state = 6` (refunded), with no accepted intent ever
recorded — the job never reached acceptance, which is what made it
refundable.

## Receipts verified against these settlements

`npx tsx scripts/verify-testnet-receipts.ts` in `packages/closeout-client`
checks receipts against the two applications above using nothing but a
public node — no Closeout API is involved, which is the only reason a
receipt is worth more than an invoice.

| Receipt | Result |
|---|---|
| Honest released receipt | **verifies** |
| Honest refunded receipt | **verifies** |
| Amount inflated to 5,000,000 | rejected — `on-chain 10000, receipt 5000000` |
| Settlement intent substituted | rejected — intent does not match the accepted one |
| Released receipt pointed at the refunded escrow | rejected — `on-chain state 6, receipt claims 5` |

## What this run does and does not show

It shows the settlement rules holding on a real chain: funds move once,
in the direction the recorded decisions point, and the unresolved job
returns to the buyer rather than paying out on uncertainty. It also shows
that a settlement record can be checked by someone who does not trust the
party that issued it.

It does not show a paid `POST /jobs` or a signed receipt. Nor does
verification say a delivery was any good — no settlement record can. Those
are the next steps, and no claim of them should be made from this run.

## Two agents, one real job

`DEPLOYER_MNEMONIC="…" pnpm --filter @closeout/demo-agents demo` — run
2026-07-28, escrow `768202344`, budget 25,000 units of asset `768202339`.

The buyer wanted an **asset control-surface report**: who, other than the
holder, can move or immobilise a holding. That is a real question with a
real answer, and not visible from a balance — chosen so the demo is not a
circular job invented to generate a settlement.

| Step | Transaction |
|---|---|
| Fund | `XUDQFHQM2AIQKGPCSKJY7VR2P4MFJAKFPZHRMJNR6QEEXJ345SCQ` |
| Deliver | `KZGA2I2P2ZYUT6DBSGXEHHIVMXOKEXVP7JQIT6OP7WYVBQRUDE7Q` |
| Accept | `UWE37TOHNBPRTPNLW5CC2CSZDB7WREFKGEERMM6NH6G5OZDKMCBQ` |
| Release | `KBMU5ASBDIAMZP4BBVKQCMYHV26XCMWYKDHKSTHWKDVCZ6UX4IBQ` |

The provider read the asset's parameters off a node and correctly reported
both findings — a freeze address and a manager address are set, so a third
party can immobilise holdings and reconfigure roles. The buyer ran the
**deterministic verifier it named before any work existed**: shape, right
asset, and findings that follow from the reported fields. No model judged
anything. The provider then submitted the release itself, and the receipt
verified against the chain on all four checks.

**What is real here and what is not.** The work, the data, the
verification, the escrow, the settlement and the receipt are real. The
budget is a TestNet stand-in asset, not money — so this demonstrates the
mechanism, not demand. Nobody has yet paid for a Closeout settlement.

## The refusal, shown beside the settlement

The run above proves the mechanism works. It never shows it *declining*
anything, which is the half a reader actually needs — a system that has
only ever been seen to succeed has not been seen to work.

Two additions close that gap.

**Reproducible now, no key required.** `pnpm --filter @closeout/demo-agents
frame` builds the honest receipt for escrow `768202344` — reading buyer,
provider, amount and the accepted intent hash back off the chain rather
than asserting them here — and a twin that differs in exactly one field,
an amount inflated from 25,000 to 250,000. It verifies both against a
public node and prints them side by side. Run 2026-08-19: the honest
receipt verifies on all four checks, the twin is rejected on `amount
matches` with `on-chain 25000, receipt 250000`. The script exits non-zero
without printing if either half comes out the other way, so the picture
cannot be produced from a result that did not happen.

Two receipt fields, `jobHash` and `taskCommitment`, are not recoverable
from chain state and are labelled as such in the output. They are not
what the on-chain check covers, and the frame does not imply otherwise.

**Written but not yet run live.** The two-agent demo now attempts a forged
release before the honest one: same escrow, same round, same parties, same
accepted delivery, with a settlement intent whose amount is ten times the
budget. The escrow compares the hash against the intent the buyer accepted
and declines; the demo aborts loudly rather than continuing if the chain
ever allows it. This path **has not been executed against TestNet** — it
needs a funded account, and none is provisioned here. It typechecks, and
the rule it exercises is covered by two contract tests (`release refuses
an intent other than the accepted one`, and the same for a provider
substituting their own). That is not the same as having watched it fail on
a live network, and it should not be described as though it were until
someone runs it.
