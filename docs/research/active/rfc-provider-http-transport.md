# RFC: Provider HTTP Transport (Forced HTTP/1.1, Idle Timeout, Proxy)

## Metadata

- Status: active
- Kind: implementation RFC (provider-core transport abstraction)
- Owner: Runtime and provider maintainers
- Last reviewed: `2026-07-08`
- Depends on:
  - pi-mono `~/new_py/pi-mono/packages/coding-agent/src/core/http-dispatcher.ts` (the borrowed shape)
  - `packages/brewva-provider-core/src/providers/openai-completions/adapter.ts` (injection site)
- Promotion target:
  - `packages/brewva-provider-core/src/providers/_shared/http-transport.ts` (the module carries the contract)
  - `docs/research/decisions/` once landed and validated

## Problem Statement And Scope Boundaries

brewva's OpenAI-compatible providers fail intermittently with `Connection error.`
(true errno `ECONNRESET`) when the bun OpenAI SDK negotiates HTTP/2 to LLM
endpoints sitting behind ByteDance's Feilian zero-trust gateway (`server:
feilian-agw`, internal `30.200.x.x`). The gateway RSTs certain h2 client SETTINGS
fingerprints during dynamic strict windows. Root cause is external (gateway x
h2); the engineering mitigation is to stop using h2 for provider calls.

In scope: a provider-scoped transport policy (forced HTTP/1.1 + idle timeout +
proxy) that consolidates the two scattered `new OpenAI({...})` construction
sites. Out of scope: MCP / non-provider HTTP (bun cannot hook a global undici
dispatcher, so the policy cannot be process-global); a config/CLI surface for
the timeout/proxy values (follow-up).

## Decision Options

- Option A (chosen): undici-backed, injected per client. Wrap
  `EnvHttpProxyAgent({ allowH2: false, bodyTimeout, headersTimeout })` as a
  `fetch` and inject it through the OpenAI SDK `fetch` option. Mirrors pi-mono's
  API; bun 1.3.12 verified to support the full undici surface.
- Option B (rejected): bun-native `globalThis.fetch` + manual `AbortSignal`.
  Zero deps, but cannot express undici's idle-based body/headers timeout and has
  no explicit `allowH2` switch — fails the "complete port" bar.

Key difference from pi-mono: its `setGlobalDispatcher` is process-global (all
undici fetch); bun's SDK does not route through global undici, so brewva injects
per client and the policy covers only OpenAI providers. This is a bun hard
constraint, not a design choice.

## Module Contract

`packages/brewva-provider-core/src/providers/_shared/http-transport.ts`:

- constants `DEFAULT_HTTP_IDLE_TIMEOUT_MS` (300_000), `HTTP_IDLE_TIMEOUT_CHOICES`
- `parseHttpIdleTimeoutMs` / `formatHttpIdleTimeoutMs` — pure, mirror pi-mono
- `applyHttpProxySettings(proxy)` — sets `HTTP_PROXY` / `HTTPS_PROXY` env
- `configureProviderTransport({ idleTimeoutMs?, httpProxy? })` — idempotent and
  re-callable; closes the previous dispatcher and rebuilds
  `EnvHttpProxyAgent({ allowH2: false, bodyTimeout, headersTimeout })`
- `getProviderFetch()` — returns `(url, init) => undici.fetch(url, { ...init,
dispatcher })`, lazily building a default dispatcher on first use

Injection: both `openai-completions/adapter.ts` and `openai-responses/adapter.ts`
construct `new OpenAI({ ..., fetch: getProviderFetch() })`. The default works
with no `configure` call (allowH2:false + 300s idle), so the h2 mitigation
lands from the injection alone.

## Source Anchors

- pi-mono `~/new_py/pi-mono/packages/coding-agent/src/core/http-dispatcher.ts:49-73` (allowH2:false + install)
- pi-mono `~/new_py/pi-mono/packages/coding-agent/src/main.ts:472-473` (global bootstrap call)
- pi-mono `~/new_py/pi-mono/packages/ai/src/providers/openai-completions.ts:503` (clean client, no fetch injection)
- brewva `packages/brewva-provider-core/src/providers/openai-completions/adapter.ts` (the `new OpenAI` site)
- brewva `packages/brewva-provider-core/src/providers/openai-responses/adapter.ts`

## Validation Signals

- bun 1.3.12: `undici.Agent({ allowH2:false, bodyTimeout, headersTimeout })`
  fetch to deepseek returns HTTP 401 (h1.1, no RST); `EnvHttpProxyAgent`
  constructible; the OpenAI SDK accepts an injected fetch.
- Native bun fetch (default h1.1) to deepseek does not RST; the SDK default
  (h2) does, intermittently (feilian window).
- The "h1.1 avoids the RST" property cannot be asserted in a stable test — the
  RST window is intermittent and gateway-side. Tests assert dispatcher config,
  not live RST.
- NOT yet verified: the OpenAI SDK consuming an `undici.fetch` `Response` (vs a
  bun-native one) under bun — the probe hit an `import openai` cwd issue.
  Implementation step 1 must confirm SDK + injected `undici.fetch` round-trips a
  stream; if it does not, fall back to injecting bun-native `globalThis.fetch`
  (also h1.1, but loses undici's idle timeout — a complete-port regression to
  flag rather than hide).

## Promotion Criteria And Destination

**Implementation state (2026-07-08):** landed on `main` (`ca2c984`). The module is
`_shared/http-transport.ts` (Option A — `EnvHttpProxyAgent({ allowH2: false, ... })`
via injected `undici.fetch`), both adapters inject `getProviderFetch()`, and the
unit tests are green (`http-transport.unit.test.ts`, 8 tests). The step-1 streaming
concern resolved in practice — the SDK round-trips the injected `undici.fetch`
stream, so no fallback to bun-native `fetch` was needed. The only remaining
promotion gate is the live one — a dogfood turn through a feilian strict window
succeeding over h1.1 — which cannot run in an autonomous pass.

Promote to `docs/research/decisions/` when: the module lands under `_shared`,
both adapters inject it, unit tests are green (parse/format/proxy + reconfigure
lifecycle + dispatcher passthrough), and a dogfood turn through a feilian strict
window succeeds over h1.1. Destination contract: the `http-transport.ts` module.

## Surface Budget

Net-zero author/operator surface; this is an internal provider-core transport.

- required authored fields: 0 -> 0
- optional authored fields: 0 -> 0
- author-facing concepts: 0 -> 0
- inspect surfaces: 0 -> 0
- routing/control-plane decision points: 0 -> 0

`configureProviderTransport` / `getProviderFetch` are package-internal APIs, not
authored config keys, CLI, or persisted formats. The follow-up (a config key for
idle timeout / proxy) will carry its own Surface Budget.
