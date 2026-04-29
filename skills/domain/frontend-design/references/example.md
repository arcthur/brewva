# Concrete Example

Input: "Define the v2 catalog page UI for skills taxonomy and routing profiles."

Output:

```yaml
ui_direction:
  The catalog is a workspace tool, not a storefront. Visual weight goes to the
  skill name, stability badge, and phase tags — the three things an operator
  scans when choosing a skill. Routing profiles are secondary metadata, shown
  inline but never competing with the skill identity. The page should feel
  dense and scannable, like a well-organized reference table, not a marketing
  grid. No cards. Use a compact list with inline expansion for details.

ui_spec:
  layout: single-column compact list, 720px max content width
  hierarchy: primary row is [stability_badge, skill_name, phase_tags] — left-aligned,
    single line, 14px/600 name, 12px/400 tags
  expansion: click row to expand inline panel showing description,
    output_contracts summary, routing_profile, and references
  state_behavior:
    loading: skeleton rows matching primary_row shape, 8 rows
    empty: centered text "No skills match the current filter" with
      reset-filter link
    error: inline banner above list, "Failed to load catalog — retry" with
      action button
    filtered: active filter chips above list with clear-all action
  breakpoints:
    <640px: phase_tags wrap below skill_name, stability_badge stays inline
    >=1024px: optional second column for routing_profile summary without
      expansion
  motion: expand/collapse is 150ms ease-out height transition, no other
    animation
```
