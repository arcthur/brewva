# Concrete Example

Input: "Split this refactor into reviewable commits and summarize the safe execution order."

Output:

```json
{
  "git_context": {
    "branch": "feat/extract-context-port",
    "worktree_clean": true,
    "upstream_status": "ahead",
    "diverged": false,
    "commit_style": "SEMANTIC"
  },
  "commit_plan": [
    {
      "order": 1,
      "scope": "packages/brewva-runtime/src/internal/legacy-runtime/model/context/",
      "message": "refactor(context): extract injection port from arena",
      "files": 3
    },
    {
      "order": 2,
      "scope": "packages/brewva-runtime/src/internal/legacy-runtime/model/context/",
      "message": "refactor(services): wire new context port into pipeline",
      "files": 2
    },
    {
      "order": 3,
      "scope": "test/",
      "message": "test(context): add injection port integration tests",
      "files": 1
    }
  ],
  "git_operation_report": "3 atomic commits created on feat/extract-context-port. No history rewrite. Branch is 3 ahead of origin. Residual risk: none — each commit passes check independently."
}
```
