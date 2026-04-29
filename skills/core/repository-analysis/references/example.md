# Concrete Example

Input: "Map the runtime-to-gateway-to-cli path and identify high-risk coupling points."

Output:

```json
{
  "repository_snapshot": "Brewva monorepo: runtime (packages/brewva-runtime) exposes semantic ports consumed by gateway (packages/brewva-gateway) via @brewva/brewva-runtime and @brewva/brewva-runtime/internal. Gateway exposes host session creation and runtime plugins. CLI (packages/brewva-cli) consumes gateway's host entrypoint for session lifecycle. Three-package chain with two cross-package boundaries.",
  "impact_map": {
    "summary": "Runtime→gateway boundary is the primary coupling surface. Gateway→CLI boundary is narrow (host session factory only). Runtime internal imports in gateway are the highest risk touchpoint.",
    "affected_paths": [
      "packages/brewva-runtime/src/runtime.ts",
      "packages/brewva-runtime/src/contracts/index.ts",
      "packages/brewva-gateway/src/host/create-hosted-session.ts",
      "packages/brewva-gateway/src/runtime-plugins/index.ts",
      "packages/brewva-cli/src/index.ts"
    ],
    "boundaries": [
      {
        "from": "brewva-runtime",
        "to": "brewva-gateway",
        "surface": "@brewva/brewva-runtime, @brewva/brewva-runtime/internal"
      },
      { "from": "brewva-gateway", "to": "brewva-cli", "surface": "@brewva/brewva-gateway/host" }
    ],
    "high_risk_touchpoints": [
      {
        "path": "packages/brewva-gateway/src/host/create-hosted-session.ts",
        "reason": "Imports @brewva/brewva-runtime/internal — changes to internal exports break gateway silently"
      }
    ],
    "change_categories": ["cross_package_contract", "public_api_surface"],
    "changed_file_classes": ["runtime_contract", "gateway_host", "cli_entrypoint"]
  },
  "planning_posture": "complex",
  "unknowns": [
    {
      "gap": "Gateway runtime-plugin re-export surface not fully traced",
      "impact": "May hide additional coupling if plugins depend on runtime internals"
    }
  ]
}
```
