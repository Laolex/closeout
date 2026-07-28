# Deploying the x402 stack

Preflight and Closeout served from one origin, under one payout account,
as one project with several paid endpoints.

## Why one origin

The Global x402 Challenge splits its rewards two ways, and they pull in
different directions:

- **500k ALGO across the top 20 _endpoints_** — more genuinely distinct
  endpoints means more slots you can occupy.
- **$100k cash across the top 5 _projects_**, judged on real usage, use
  case quality, technical execution and long-term potential — which
  rewards one coherent thing rather than a pile of thin ones.

Serving both from `x402.clearcrew.xyz` under one payout account satisfies
both: three distinct endpoints that a judge reads as a single stack —
*check before you sign, settle with proof*.

| Endpoint | Service | Sells |
|---|---|---|
| `POST /preflight` | Preflight :8894 | what a transaction group will actually do |
| `POST /asset-risk` | Preflight :8894 | who can freeze or claw back a holding |
| `POST /jobs` | Closeout :8893 | a verifiable settlement record for delivered work |

Ports 8893/8894 deliberately avoid **8080, which is the trading-agents
service on this host**.

## Prerequisites, in order

1. **DNS.** `x402.clearcrew.xyz` → `141.227.131.22` (A record). Nothing
   below works without it, and `clearcrew.xyz` currently has **no record
   at all** — which is why Preflight's published `resource` is presently
   unreachable and would score zero however well funded it is.
2. **A funded MainNet payout account**, opted into USDC (`31566704`). An
   account that has not opted in **bounces every payment made to it**,
   from the payer's side, after they have already signed.
3. Only then install the Caddy site — Caddy issues a certificate on
   reload, and a name that does not point here turns that into repeated
   failures against a rate-limited CA.

## Install

```bash
sudo mkdir -p /var/lib/closeout /var/log/closeout
sudo cp deploy/closeout.env.example /etc/closeout.env   # then edit
sudo chmod 600 /etc/closeout.env

sudo cp deploy/closeout-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now closeout-api

sudo cp deploy/x402.clearcrew.xyz.caddy /etc/caddy/Caddyfile.d/
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Point Preflight at the same origin and port: set `PUBLIC_BASE_URL` to
`https://x402.clearcrew.xyz` and `PORT` to `8894` in
`/opt/algo-preflight/.env`. It currently publishes `https://clearcrew.xyz`
on port 8080, and both are wrong here.

## Verify before believing it works

```bash
# Requirements published, tagged, and naming a reachable resource
curl -s -X POST https://x402.clearcrew.xyz/jobs -d '{}' | jq '.accepts[0].extra'
curl -s -X POST https://x402.clearcrew.xyz/preflight -d '{}' | jq '.accepts[0].resource'

# The resource URL must answer, not just parse
curl -sI "$(curl -s -X POST https://x402.clearcrew.xyz/jobs -d '{}' | jq -r '.accepts[0].resource')"

# And the endpoints must appear in the catalog the leaderboard reads
curl -s https://facilitator.goplausible.xyz/discovery/resources \
  | jq '.items[] | select(.resourceUrl | contains("clearcrew")) | {resourceUrl, tag: .accepts[0].extra.tag}'
```

`extra.tag` must read `x402-global-challenge` on every paid endpoint.
Without it the endpoint takes real payments and scores nothing, and
nothing about serving traffic reveals the omission.

## Still required, and not code

- **Register before Sept 1 2026, 23:45 ET.** The form closes then;
  additional project information is due Sept 29. Usage accumulated
  without registering counts for nothing.
- At least one real MainNet USDC payment through each endpoint.
- Do not drive volume between your own endpoints. Real usage is a named
  judging criterion, and circular traffic is the first thing worth
  scanning for.
