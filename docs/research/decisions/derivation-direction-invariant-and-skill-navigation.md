# Decision: Derivation Direction Invariant And Skill Navigation View

## Metadata

- Decision: Descriptive skill metadata derives read-only views; the runtime never derives an unbypassable decision from it. A generated navigation view projects the in-body handoff prose, fenced by import-boundary, parser-non-absorption, and referential-integrity lints.
- Date: `2026-06-18`
- Status: accepted
- Stable docs:
  - `docs/architecture/design-axioms.md`
  - `docs/reference/skill-routing.md`
  - `docs/reference/skill-navigation.md`
- Code anchors:
  - `script/generate-skill-navigation.ts`
  - `test/fitness/skill-navigation-boundary.fitness.test.ts`
  - `test/fitness/docs/skill-navigation-fresh.fitness.test.ts`

## Decision Summary

- Descriptive metadata (skill bodies and SkillCard fields) may derive views, but must never feed an unbypassable runtime decision. Derivation is one-way: authoritative state feeds descriptive views, never the reverse.
- The boundary has three tiers. Tier 1 (`descriptive -> doc view`) is allowed. Tier 2 (`descriptive -> advisory runtime`) is allowed only as the registered selection-field ranking exception. Tier 3 (`descriptive -> authoritative gate`: a readiness gate, skill activation, or artifact resolver) is forbidden.
- Cross-skill handoff prose in each `SKILL.md` body — a verb from the closed set `escalate to`, `hand off to`, `route to` (the one-word `handoff to` spelling is accepted) before a backticked skill name — is the source of record. The aggregate `docs/reference/skill-navigation.md` is a generated Tier-1 derivative, verified by regenerate-and-diff, never a hand-written sibling.
- The deterministic selector reading `SkillCard.selection`, `name`, and `description` is registered as the sole Tier-2 exception. Any new `descriptive -> runtime` read site must be registered or it is a Tier-3 violation.

## Boundaries

- The view models only handoff (exit) edges. Entry-correction redirects (the "use X instead" references in a skill's "Do NOT use" section) are a separate, unmodeled navigation relation.
- Cycles are expected — two skills may hand off to each other under different conditions — and are surfaced as strongly-connected groups, not rejected. Only dangling targets and self-loops fail the integrity lint.
- The generator is build-time tooling under `script/`; no runtime package imports it or reads the view, and the generator imports no `@brewva` package.

## Axioms

This decision is judged against `docs/architecture/design-axioms.md`:

- Obeys axiom 18 (Descriptive metadata derives views, never authority): this decision is the operational form of that axiom, made provable as an import boundary.
- Obeys axiom 1 (Attention belongs to the model): a Tier-3 gate derived from metadata would seize salience the model owns.
- Obeys axiom 2 (Adaptive logic stays out of the kernel): metadata-derived routing is adaptive logic, kept in dev tooling and docs rather than the runtime.
- Obeys axiom 3 (Subtraction beats switches): three case-by-case rejections collapse into one import-boundary rule, and the generator is dev tooling, not a runtime switch.
- Obeys axiom 14 (Documentation hierarchy follows authority hierarchy): the navigation view is descriptive documentation and does not widen authority.

## Relates To

- `docs/research/decisions/skill-metadata-as-runtime-contract-and-routing-substrate.md` — removed the prior `consumes`/routing substrate; this decision names the invariant that forecloses reintroducing it.
