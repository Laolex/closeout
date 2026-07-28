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

## What this run does and does not show

It shows the settlement rules holding on a real chain: funds move once,
in the direction the recorded decisions point, and the unresolved job
returns to the buyer rather than paying out on uncertainty.

It does not show a paid `POST /jobs`, a receipt, or a third party
verifying a settlement without our API. Those are the next steps, and no
claim of them should be made from this run.
