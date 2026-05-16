# Concrete Example

Input: "Define the v2 catalog page UI for SkillCards, ProducerContracts, and capability authority."

Output:

```yaml
ui_direction:
  The catalog is a workspace tool, not a storefront. Visual weight goes to the
  SkillCard name, category, and advisory selection summary. ProducerContracts
  and capabilities are separate metadata lanes so operators can distinguish
  reference context from authority. The page should feel dense and scannable,
  like a well-organized reference table, not a marketing grid. No cards. Use a
  compact list with inline expansion for details.

ui_spec:
  layout: single-column compact list, 720px max content width
  hierarchy: primary row is [category_badge, skill_name, selection_summary] — left-aligned,
    single line, 14px/600 name, 12px/400 summary
  expansion: click row to expand inline panel showing description,
    ProducerContract summary, capability authority status, and references
  state_behavior:
    loading: skeleton rows matching primary_row shape, 8 rows
    empty: centered text "No skills match the current filter" with
      reset-filter link
    error: inline banner above list, "Failed to load catalog — retry" with
      action button
    filtered: active filter chips above list with clear-all action
  breakpoints:
    <640px: selection_summary wraps below skill_name, category_badge stays inline
    >=1024px: optional second column for ProducerContract summary without
      expansion
  motion: expand/collapse is 150ms ease-out height transition, no other
    animation
```
