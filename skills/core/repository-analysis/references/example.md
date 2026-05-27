# Concrete Example

Input: "Map the runtime-to-gateway-to-cli path and identify high-risk coupling points."

Output:

```json
{
  "repository_snapshot": "Brewva monorepo: runtime (packages/brewva-runtime) exposes four-port runtime contracts consumed by gateway (packages/brewva-gateway) via @brewva/brewva-runtime plus dedicated controlled subpaths. Gateway exposes hosted session creation and advisory extensions. CLI (packages/brewva-cli) consumes gateway's hosted entrypoint for session lifecycle. Three-package chain with two cross-package boundaries.",
  "impact_map": {
    "summary": "Runtime→gateway boundary is the primary coupling surface. Gateway→CLI boundary is narrow (host session factory only). Controlled extension ports and dedicated subpaths are the implementation-adjacent runtime touchpoints.",
    "affected_paths": [
      "packages/brewva-runtime/src/runtime/runtime.ts",
      "packages/brewva-runtime/src/public/index.ts",
      "packages/brewva-gateway/src/hosted/session.ts",
      "packages/brewva-gateway/src/hosted/internal/session/index.ts",
      "packages/brewva-cli/src/index.ts"
    ],
    "boundaries": [
      {
        "from": "brewva-runtime",
        "to": "brewva-gateway",
        "surface": "@brewva/brewva-runtime, dedicated runtime subpaths"
      },
      { "from": "brewva-gateway", "to": "brewva-cli", "surface": "@brewva/brewva-gateway/hosted" }
    ],
    "high_risk_touchpoints": [
      {
        "path": "packages/brewva-gateway/src/hosted/session.ts",
        "reason": "Exposes hosted session creation; changes to advisory extension composition affect gateway-hosted wiring"
      }
    ],
    "change_categories": ["cross_package_contract", "public_api_surface"],
    "changed_file_classes": ["runtime_contract", "gateway_host", "cli_entrypoint"]
  },
  "planning_posture": "complex",
  "unknowns": [
    {
      "gap": "Gateway advisory extension composition not fully traced",
      "impact": "May hide additional coupling if extensions depend on hosted internals"
    }
  ]
}
```
