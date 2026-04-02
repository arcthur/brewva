# Output Patterns

Use these patterns when skills need to produce consistent, high-quality output.

Pair each declared output with an explicit `intent.output_contracts` entry in
frontmatter. Keep the contract just strong enough to reject placeholder output
without over-constraining normal use.

## Structured Array Pattern

When downstream tooling consumes arrays of typed objects, encode that shape in
the contract instead of leaving it to prose.

```yaml
intent:
  outputs:
    - execution_plan
  output_contracts:
    execution_plan:
      kind: json
      min_items: 1
      item_contract:
        kind: json
        required_fields:
          - step
          - intent
          - owner
          - exit_criteria
          - verification_intent
```

Use this pattern for artifacts such as execution steps, risk registers,
implementation targets, or checklists that must be machine-readable after the
skill returns.

## Template Pattern

Provide templates for output format. Match the level of strictness to your needs.

**For strict requirements (like API responses or data formats):**

```markdown
## Report structure

ALWAYS use this exact template structure:

# [Analysis Title]

## Executive summary

[One-paragraph overview of key findings]

## Key findings

- Finding 1 with supporting data
- Finding 2 with supporting data
- Finding 3 with supporting data

## Recommendations

1. Specific actionable recommendation
2. Specific actionable recommendation
```

**For flexible guidance (when adaptation is useful):**

```markdown
## Report structure

Here is a sensible default format, but use your best judgment:

# [Analysis Title]

## Executive summary

[Overview]

## Key findings

[Adapt sections based on what you discover]

## Recommendations

[Tailor to the specific context]

Adjust sections as needed for the specific analysis type.
```

## Examples Pattern

For skills where output quality depends on seeing examples, provide input/output pairs:

```markdown
## Commit message format

Generate commit messages following these examples:

**Example 1:**
Input: Added user authentication with JWT tokens
Output:
```

feat(auth): implement JWT-based authentication

Add login endpoint and token validation middleware

```

**Example 2:**
Input: Fixed bug where dates displayed incorrectly in reports
Output:
```

fix(reports): correct date formatting in timezone conversion

Use UTC timestamps consistently across report generation

```

Follow this style: type(scope): brief description, then detailed explanation.
```

Examples help Claude understand the desired style and level of detail more clearly than descriptions alone.

## Pre-Delivery Checklist Pattern

When output quality depends on several concrete last-mile checks, add a short
pre-delivery checklist.

This pattern is useful for:

- release handoff artifacts
- UI or interaction specs
- structured payloads consumed by downstream tooling

Prefer checks that another operator could verify quickly:

```markdown
## Pre-Delivery Checklist

- [ ] Required sections are present
- [ ] All critical states or branches are covered
- [ ] Ambiguities are called out explicitly instead of hidden
- [ ] The artifact names the next action, not just observations
```

For domain-specific work, make the checks domain-specific:

```markdown
## Pre-Delivery Checklist

- [ ] Loading, empty, error, and success states are specified
- [ ] Primary action and fallback action are distinguishable
- [ ] Breakpoint or layout constraints are named where relevant
- [ ] Motion guidance is intentional, not decorative filler
```

Keep the checklist short. If it grows large, move the domain-specific version
into `references/` and link to it from the main skill.
