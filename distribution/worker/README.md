# Cloudflare Worker Edge Ingress (Telegram)

This folder provides a minimal Worker entrypoint and deployment template for
the Telegram webhook ingress path:

- Worker entrypoint: `distribution/worker/telegram-webhook-worker.ts`
- Wrangler template: `distribution/worker/wrangler.toml.example`
- Worker implementation: `packages/brewva-ingress/src/telegram-webhook-worker.ts`

## What This Worker Does

- Validates Telegram webhook secret token
- Optional ACL checks (`chat_id` / `user_id` allow-lists)
- Optional rate limiting (`chat|user|global`)
- Edge dedupe by `update_id` (in-memory by default, KV optional)
- Forwards raw update payload to Fly ingress using HMAC-signed headers

## Deploy

1. Create `wrangler.toml` from template:

```bash
cp distribution/worker/wrangler.toml.example distribution/worker/wrangler.toml
```

2. Set required variables and optional secrets:

- Required:
  - `BREWVA_INGRESS_URL`
  - `BREWVA_INGRESS_HMAC_SECRET`
- Optional:
  - `BREWVA_TELEGRAM_SECRET_TOKEN`
  - `BREWVA_INGRESS_BEARER_TOKEN`
  - `BREWVA_TELEGRAM_ALLOWED_CHAT_IDS`
  - `BREWVA_TELEGRAM_ALLOWED_USER_IDS`
  - `BREWVA_TELEGRAM_RATE_LIMIT_MAX`
  - `BREWVA_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS`
  - `BREWVA_TELEGRAM_RATE_LIMIT_SCOPE`
  - `BREWVA_TELEGRAM_DEDUPE_KV` binding for cross-instance best-effort dedupe

3. Deploy Worker:

```bash
cd distribution/worker
wrangler deploy
```

4. Register Telegram webhook:

```bash
curl -sS -X POST "https://api.telegram.org/bot<bot-token>/setWebhook" \
  -d "url=https://<worker-domain>/telegram/webhook" \
  -d "secret_token=<telegram-secret-token>"
```

## Fly Ingress Configuration

Run channel mode with webhook ingress enabled on Fly:

```bash
export BREWVA_TELEGRAM_WEBHOOK_ENABLED=1
export BREWVA_TELEGRAM_INGRESS_HOST=0.0.0.0
export BREWVA_TELEGRAM_INGRESS_PORT=8787
export BREWVA_TELEGRAM_INGRESS_PATH=/ingest/telegram
export BREWVA_TELEGRAM_INGRESS_AUTH_MODE=hmac
export BREWVA_TELEGRAM_INGRESS_HMAC_SECRET=<same-as-worker>

bun run start -- --channel telegram --telegram-token <bot-token>
```

## Local Smoke Run

Run a local end-to-end simulation (Worker -> local ingress server):

```bash
bun run test:webhook-smoke
```

Expected output includes:

- first request accepted
- second request deduped
- ingress dispatch count is `1`

## Live Smoke Run (Staging/Production)

Run a live path probe against the deployed Worker endpoint:

```bash
export BREWVA_WEBHOOK_LIVE_URL="https://<worker-domain>/telegram/webhook"
export BREWVA_WEBHOOK_LIVE_TELEGRAM_SECRET="<telegram-secret-token>"
export BREWVA_WEBHOOK_LIVE_CHAT_ID="12345"
export BREWVA_WEBHOOK_LIVE_USER_ID="42"

bun run test:webhook-smoke:live
```

Optional strict dedupe assertion:

```bash
export BREWVA_WEBHOOK_LIVE_ASSERT_DEDUPE=1
bun run test:webhook-smoke:live
```

Notes:

- Default mode validates end-to-end forwarding with one unique update.
- Dedupe assertion sends the same update twice and expects either:
  - Worker edge duplicate (`code=duplicate`), or
  - ingress idempotency hit (`code=accepted` and `ingressStatus=409`).

## Multi-Instance Caveats

### Edge deduplication (Worker)

By default the Worker uses an in-process `InMemoryReplayStore`. Each Worker
instance maintains its own dedupe window, so the same `update_id` can be
forwarded once per instance in a concurrent burst.

When `BREWVA_TELEGRAM_DEDUPE_KV` is bound, the Worker uses Cloudflare KV
instead. KV does not support compare-and-swap, so the dedupe is still
best-effort: two instances that both read a missing key before either writes it
will both forward the update.

For truly atomic cross-instance deduplication, replace `KvReplayStore` with a
Durable Object that serialises reads and writes in a single SQLite transaction.

### Rate limiting (Worker)

`InMemoryRateLimiter` state is local to each Worker instance. In a
multi-instance deployment the effective global rate limit is
`BREWVA_TELEGRAM_RATE_LIMIT_MAX` × `instance count`. For true global rate
limiting use Cloudflare Durable Objects or the Cloudflare Rate Limiting API.

### Nonce replay protection (Fly ingress)

The Fly ingress uses an `InMemoryReplayStore` for nonce tracking by default.
Nonce uniqueness is therefore enforced per-process. In a multi-instance Fly
deployment the same nonce can be accepted once per instance within the skew
window. The HMAC timestamp window (`hmacMaxSkewMs`, default 5 minutes) remains
the primary replay protection boundary regardless of instance count.

To strengthen this, inject a shared `nonceStore` implementation backed by a
Redis or Fly Volume store via `TelegramIngressProcessorOptions.nonceStore`.

### ACL drops are edge-only

Updates dropped at the Worker (`code: "dropped_acl"`) never reach Fly, so they
are not visible in `runtime.events`. Use `wrangler tail` to observe ACL drop
events in production.

## Rollback

1. Pause webhook delivery:

```bash
curl -sS -X POST "https://api.telegram.org/bot<bot-token>/deleteWebhook"
```

2. Roll back Worker to previous version:

```bash
cd distribution/worker
wrangler deployments list
# pick previous version id, then:
wrangler rollback <deployment-id>
```

3. Switch back to polling if needed:

- unset `BREWVA_TELEGRAM_WEBHOOK_ENABLED`
- restart `brewva --channel telegram` with polling defaults
