# Decision: Kimi Code Token Cache Adapter

## Metadata

- Decision: `provider="kimi-coding"` or a base URL under `api.kimi.com/coding` resolves to unsupported cache capability with `reason="kimi_code_cache_contract_not_verified"`.
- Date: `2026-04-26`
- Status: accepted
- Stable docs:
  - `docs/reference/token-cache.md`
- Code anchors:
  - `packages/brewva-provider-core/src/cache/capability.ts`
  - `packages/brewva-provider-core/src/cache/render/anthropic.ts`
  - `packages/brewva-provider-core/src/cache/render/openai-completions.ts`
  - `packages/brewva-provider-core/src/providers/anthropic/index.ts`
  - `packages/brewva-provider-core/src/providers/openai-completions/index.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/connection-port.ts`
  - `test/unit/provider-core/cache-policy.unit.test.ts`
  - `test/live/provider/token-cache.live.test.ts`
  - `packages/brewva-provider-core/src/catalog/models.generated.ts`
  - `packages/brewva-provider-core/src/providers/_shared/payload-metadata.ts`

## Decision Summary

- `provider="kimi-coding"` or a base URL under `api.kimi.com/coding` resolves to unsupported cache capability with `reason="kimi_code_cache_contract_not_verified"`.
- Kimi Code provider payloads do not receive Anthropic `cache_control` markers or GPT `prompt_cache_key` fields by inheritance.
- Kimi Code does not claim Codex-style continuation or reuse continuation state across model switches.
- Kimi-specific cache fields, counters, sticky latches, or continuation state may be added only through provider-core capability/render metadata after the provider behavior is documented or live-verified.
- Gateway fingerprints may consume provider-neutral rendered cache metadata, but gateway must not branch on Kimi-specific payload fields or headers.

## Superseded by

- None.
