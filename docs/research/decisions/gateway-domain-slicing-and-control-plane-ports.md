# Decision: Gateway Domain Slicing And Control-Plane Ports

## Metadata

- Decision: gateway public seams stay domain-sliced, and control-plane commands live under `admin`
- Date: `2026-05-10`
- Status: accepted
- Stable docs:
  - `docs/reference/extensions.md`
  - `docs/reference/session-lifecycle.md`
  - `docs/reference/commands.md`
  - `docs/architecture/system-architecture.md`
- Code anchors:
  - `packages/brewva-gateway/src/admin/api.ts`
  - `packages/brewva-gateway/src/admin/internal/cli.ts`
  - `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`
  - `packages/brewva-gateway/src/hosted/internal/provider/types.ts`
  - `packages/brewva-gateway/src/utils`

## Decision Summary

- `@brewva/brewva-gateway` keeps explicit domain seams instead of reviving flat root implementation files
- control-plane CLI helpers and command routing live under `packages/brewva-gateway/src/admin/`; `ingress/` keeps transport and auth helpers
- the runtime-plugin public seam is `packages/brewva-gateway/src/hosted/internal/session/host-api-installation.ts`; family implementations stay inside their domain folders
- provider connection metadata uses `ProviderConnectionDescriptor`; the four-port seam stays `credential`, `authFlow`, `catalog`, and `renderer`
- `packages/brewva-gateway/src/utils` remains an explicit shared root and must not import gateway domains
- gateway internalization work may continue domain by domain, but cross-domain callers must keep using `api.ts` or `types.ts` seams instead of source-path shortcuts

## Superseded by

- None.
