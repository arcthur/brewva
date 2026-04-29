# Concrete Example

Input: "Summarize the failing checks on PR #42 and draft a follow-up comment."

Output:

```json
{
  "github_context": {
    "repo": "brewva",
    "owner": "bytedance",
    "authenticated": true,
    "current_pr": 42,
    "branch": "fix/type-check-regression"
  },
  "ci_findings": {
    "failing_checks": [
      { "name": "typecheck", "conclusion": "FAILURE" },
      { "name": "lint", "conclusion": "FAILURE" }
    ],
    "passing_count": 5,
    "failing_count": 2,
    "pending_count": 0,
    "likely_causes": ["Type error in packages/brewva-runtime/src/config/normalize.ts:47"],
    "recommended_actions": ["Fix the type narrowing, rerun bun run check locally"]
  },
  "pr_brief": {
    "summary": "Two checks failing: typecheck and lint. Root cause is a missing type guard in normalize.ts. Suggested comment drafts a fix path and asks for confirmation before pushing.",
    "draft_comment": "CI shows typecheck + lint failures tracing to a missing type guard in `normalize.ts:47`. Proposed fix: add the narrowing guard and verify with `bun run check`. Want me to proceed?"
  }
}
```
