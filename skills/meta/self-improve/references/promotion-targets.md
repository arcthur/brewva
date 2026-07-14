# Promotion Targets

When a learning proves broadly applicable, promote it out of `.brewva/learnings/`
to a permanent location. Promotion is a two-step act: `scripts/promote.sh` emits
a reviewable candidate; a human lands it in the target as a reviewed diff. No
target file is ever written by the script — `AGENTS.md` in particular has no
automated append path.

## Target Matrix

| Learning Type       | Target                                    | When                                 |
| ------------------- | ----------------------------------------- | ------------------------------------ |
| Project convention  | `AGENTS.md`                               | Affects how agents work in this repo |
| Workspace pattern   | `AGENTS.md` (CONVENTIONS / ANTI-PATTERNS) | Cross-cutting coding rule            |
| Runtime behavior    | `docs/reference/`                         | Behavior an operator needs to know   |
| Core advisory skill | `skills/core/<name>/SKILL.md`             | Reusable advisory workflow boundary  |
| Domain recipe       | `skills/domain/<name>/SKILL.md`           | Domain-specific tool knowledge       |
| Operator workflow   | `skills/operator/<name>/SKILL.md`         | Audit / archaeology / git-safe ops   |
| Meta workflow       | `skills/meta/<name>/SKILL.md`             | Authoring or learning meta-logic     |
| Project overlay     | `skills/project/overlays/<name>/SKILL.md` | Tightens a base skill for Brewva     |
| Shared project rule | `skills/project/shared/<name>.md`         | Shared repo context, not a skill     |

## Promotion Criteria

A learning qualifies for a promotion candidate through exactly one of two
paths — matching the self-improve Iron Law (`NO SYSTEMIC CLAIM WITHOUT
REPEATED EVIDENCE`):

| Path                  | Requirement                                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recurrence**        | 2+ independent occurrences, cited in the candidate (`See Also` links, `Recurrence-Count >= 2`, or evidence anchors from distinct sessions)                                          |
| **Operator-directed** | An explicit human instruction ("save this", "remember this", "promote this"). This is an authorization signal, not a correctness signal — the reviewed landing carries correctness. |

Signals that support a candidate but never qualify one on their own:
`resolved` status with a working fix, "required actual debugging",
"broadly applicable". A single resolved incident routes to
`knowledge-capture` (a solution record), not to a permanent instruction
surface.

## Promotion Workflow

1. Verify the learning is still accurate and complete.
2. Choose the target from the matrix above.
3. Run `scripts/promote.sh <entry-id> <target>`:
   - `agents` emits a candidate file under `.brewva/learnings/candidates/`
     carrying the qualification checklist, provenance, and a re-evaluation
     date. The source entry's status becomes `candidate`.
   - `docs` and `skill` print the manual path.
4. A human reviews the candidate and, if accepted, lands the entry in the
   target as a reviewed diff, sets the source entry's status to `promoted`,
   and records the landing commit in the candidate file (or deletes it).
5. A candidate whose re-evaluation date passes without landing expires: reset
   the source entry to `pending` and delete the candidate file.
6. If the learning came out of a harness candidate experiment, cite its
   `candidateId` in the promoted entry (`**Candidate**: <candidateId>`) —
   the id appears in the compare report and in
   `.brewva/harness/candidates.jsonl`, so the promoted guidance stays
   traceable to the evaluation and accept/reject receipts behind it.

## Quality Gates Before Landing

- [ ] The qualification path (recurrence or operator-directed) is confirmed
      with citations, not asserted.
- [ ] Solution is tested and still working.
- [ ] Description is self-contained (no implicit session context).
- [ ] Code examples run without project-specific hardcoded values.
- [ ] Target location doesn't already contain equivalent guidance.

## Skill Extraction (Special Case)

When promoting to a new skill, the extracted skill must satisfy Brewva DoD:

- Use the current category layout (`core`, `domain`, `operator`, `meta`, or `project/overlays`)
- Do not add `tier` or `category` frontmatter; category is directory-derived
- YAML frontmatter with compact SkillCard fields only: `name`, `description`,
  optional `selection`, optional `references`, optional `scripts`, and optional
  `invariants`
- Put structured outputs in `skills/producers/<name>.yaml`
- Put external authority in capability manifests, not in `SKILL.md`
- Sections: Objective, Trigger, Workflow, Stop Conditions, Anti-Patterns, Examples
- Pass `skills/project/scripts/check-skill-dod.sh`

Use `scripts/extract-skill.sh <name>` to scaffold a compliant skill from a learning.
