# Promotion Targets

When a learning proves broadly applicable, promote it out of `.brewva/learnings/` to a
permanent location. Use `scripts/promote.sh` or apply manually.

## Target Matrix

| Learning Type      | Target                                    | When                                 |
| ------------------ | ----------------------------------------- | ------------------------------------ |
| Project convention | `AGENTS.md`                               | Affects how agents work in this repo |
| Workspace pattern  | `AGENTS.md` (CONVENTIONS / ANTI-PATTERNS) | Cross-cutting coding rule            |
| Runtime behavior   | `docs/reference/`                         | Behavior an operator needs to know   |
| Recurring fix      | `skills/base/<name>/SKILL.md`             | Reusable debugging / workflow skill  |
| Domain recipe      | `skills/packs/<name>/SKILL.md`            | Domain-specific tool knowledge       |
| Project recipe     | `skills/project/<name>/SKILL.md`          | Brewva-specific operational skill    |

## Promotion Criteria

A learning qualifies for promotion when **any** of these hold:

| Criterion          | Signal                                                   |
| ------------------ | -------------------------------------------------------- |
| Recurring          | 2+ `See Also` links or `Recurrence-Count >= 2`           |
| Verified           | Status is `resolved` with working fix                    |
| Non-obvious        | Required actual debugging/investigation                  |
| Broadly applicable | Not session-specific; useful across sessions             |
| User-flagged       | User says "save this" / "remember this" / "promote this" |

## Promotion Workflow

1. Verify the learning is still accurate and complete.
2. Choose target from the matrix above.
3. Run `scripts/promote.sh <entry-id> <target>` or apply manually.
4. Update the original entry: `**Status**: promoted`, `**Promoted**: <target>`.

## Quality Gates Before Promotion

- [ ] Solution is tested and still working
- [ ] Description is self-contained (no implicit session context)
- [ ] Code examples run without project-specific hardcoded values
- [ ] Target location doesn't already contain equivalent guidance

## Skill Extraction (Special Case)

When promoting to a new skill, the extracted skill must satisfy Brewva DoD:

- YAML frontmatter with `name`, `description`, `version`, `stability`, `tier`, `tags`, `tools`, `budget`, `outputs`
- Sections: Objective, Trigger, Workflow, Stop Conditions, Anti-Patterns, Examples
- Pass `scripts/check-skill-dod.sh` from `brewva-project`

Use `scripts/extract-skill.sh <name>` to scaffold a compliant skill from a learning.
