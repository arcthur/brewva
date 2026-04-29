# Concrete Example

Input: "Open the docs site, confirm the broken nav state, and capture the failing selector."

Output:

```json
{
  "browser_observations": "Navigation sidebar on /docs/reference/runtime renders an empty <ul> with class 'nav-tree'. Console shows 'TypeError: Cannot read properties of undefined (reading map)' at nav-tree.tsx:42. The sidebar data fetch returns 200 but payload.children is null when category is 'reference'. Other categories render correctly. The broken state is deterministic on page load, not a race condition.",
  "browser_artifacts": {
    "screenshots": ["docs-nav-broken-state.png"],
    "snapshots": ["docs-nav-aria-snapshot.yaml"],
    "console_errors": [
      "TypeError: Cannot read properties of undefined (reading 'map') at NavTree (nav-tree.tsx:42)"
    ],
    "failing_selector": "ul.nav-tree > li (zero children when category=reference)",
    "evidence_url": "http://localhost:3000/docs/reference/runtime"
  }
}
```
