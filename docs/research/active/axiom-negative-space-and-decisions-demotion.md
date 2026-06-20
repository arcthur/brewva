# Active: Axiom Negative-Space Linkage And Decisions Demotion — Deepening

## Metadata

- Status: `active`
- Owner: `Arthur / runtime-maintainers`
- Last reviewed: `2026-06-20`
- Promotion target:
  - `skills/project/shared/critical-rules.md`
  - `skills/project/shared/anti-patterns.md`
  - `docs/reference/axiom-enforcement.md`
  - `script/generate-axiom-enforcement.ts`
  - `test/fitness/docs/axiom-enforcement-fresh.fitness.test.ts`
  - `docs/architecture/design-axioms.md`
  - `docs/research/decisions/README.md`
  - `docs/research/README.md`

## Purpose Of This Note

The framing note (`axiom-negative-space-and-decisions-demotion.md`) identified
a real symptom — "to know what not to do you must spelunk ~125 decision
records" — and proposed a real, conservative fix (a hand-authored
negative-space map + per-rule axiom tags + a `decisions/` demotion + a fitness
guard). This note does not reject that diagnosis. It deepens it on three axes
the framing note left implicit, because each axis changes the recommended
shape:

1. **It measures the actual cost and gets a surprising result**: the decision
   archive is _already_ demoted in fact, if not in framing. The "heavy" weight
   the framing note reacts to is not the archive — it is the _citation
   forcing function_, which is thin.
2. **It tests the framing note's chosen option against Brewva's own axioms**
   and finds that a hand-authored negative-space map is itself a second-source
   anti-pattern under axiom 18 (`Descriptive metadata derives views, never
authority`) and a switch under axiom 3 (`Subtraction beats switches`). The
   map should be _generated_, not authored.
3. **It reframes the self-learning loop**: the archive is not dead weight to
   demote — it is the training corpus, and Brewva already has the generated-view
   pattern (`script/generate-skill-navigation.ts`) that turns a corpus into one
   scannable surface without a second hand-authored truth.

The conclusion is narrower and stronger than the framing note: **generate the
negative-space map from the axioms + rule docs the way skill-navigation is
generated from skill bodies, demote the archive framing in prose only, and do
not add any hand-authored anti-patterns doc.** The archive stays exactly where
it is.

## Part 1 — What The Corpus Actually Looks Like (Evidence)

Before deciding how to lighten the `decisions/` ring, measure it. The numbers
do not match the framing note's "~127 records you must spelunk" intuition:

| Measure                                         | Value          | Source                                                                    |
| ----------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| Decision records (excl. README)                 | **125**        | `ls docs/research/decisions/*.md`                                         |
| Records carrying an `## Axioms` section         | **9**          | `grep -l '^## Axioms'`                                                    |
| Records grandfathered pre-cutoff (`2026-06-13`) | **~116 (93%)** | date histogram                                                            |
| Inbound reference sites in _stable_ docs        | **7 files**    | `grep -rl`                                                                |
| Fitness tests that read `decisions/`            | **3**          | `code-paths`, `research-index-consistency`, `canonical-turn-envelope-rfc` |
| Max accepted decision length                    | **80 lines**   | enforced by `research-index-consistency` fitness                          |
| Axiom count in `design-axioms.md`               | **18**         | enumerated                                                                |

Two facts fall out of this that reshape the problem:

**Fact A — the archive is already demoted.** The decision corpus is
write-once, ≤80-line, boilerplate-banned (the `research-index-consistency`
fitness explicitly rejects Surface Budget / Validation Status / checklists /
status pointers inside decision records), and consumed by exactly 7 stable
doc files and 3 fitness tests. Nothing in `packages/**` reads it. Nothing in
`AGENTS.md` points a contributor at it as a place to look for current rules.
The framing note's own Option B conceded this ("records are immutable,
near-zero ongoing maintenance"). The prose in `decisions/README.md` already
says "Read stable docs first; use this directory only when you need
provenance." So the _contract_ is already right. The thing that feels heavy
is the _count_ — 125 files — not the authority.

**Fact B — the citation forcing function is thin, not heavy.** Only 9 of 125
records cite axioms, because the `2026-06-13` cutoff grandfathered the
back-catalog. The `decision-axiom-citations` fitness guards only _new_
records. This is the actual gap the framing note is feeling: the _forward_
linkage (axiom ← → rule ← → decision) is enforced for new decisions but
absent for the rules themselves. The rule docs (`critical-rules.md`,
`anti-patterns.md`) name _patterns_ and _files_ but never name the axiom they
serve. That is the missing scannable surface — and it is a property of the
rule docs, not of the archive.

So the framing note's title ("decisions demotion") slightly mislabels the
fix. The archive does not need demoting; the _rule docs_ need an axiom
back-pointer, and that back-pointer should not be a fourth hand-authored
document.

## Part 2 — The Framing Note's Chosen Option, Tested Against The Axioms

The framing note chose Option D: hand-author a `## Negative Space &
Enforcement` section in `design-axioms.md`, plus `(axiom N)` tags in the rule
docs, plus a fitness guard. Run that through Brewva's own constitution:

**Against axiom 18 (`Descriptive metadata derives views, never authority`).**
A hand-authored negative-space map is a _second source_ for "which rule
enforces which axiom." The axiom and the rule each already exist as
authoritative text. A human-maintained table that says "axiom 5 is enforced by
critical-rules bullet 7" is a descriptive _derivation_ — it should be
**derived from** the rule docs (which now carry `(axiom N)` tags) the same way
`skill-navigation.md` is derived from skill bodies. Hand-authoring it creates
exactly the drift surface axiom 18 exists to forbid: the map says one thing,
the rule doc says another, and there is no forcing function until the next
audit. The framing note's own fitness guard only checks that _references
resolve_ — it cannot check that the map is _faithful_, because faithfulness
between two hand-written texts is not mechanically checkable. Generation makes
faithfulness a tautology.

**Against axiom 3 (`Subtraction beats switches`).** A hand-authored map is an
additive surface — one more doc to read, one more to update when an axiom or
rule changes. Its own `Surface Budget` concedes a `0 -> 1` author-facing
concept delta and tries to justify it as "consolidating." That is the switch
axiom 3 warns against: a new index that duplicates reachability already
present in the rule docs. The generated alternative _subtracts_: it removes
the need to author the map at all, and it removes the need for a human to keep
two rule inventories in sync.

**Against axiom 1 (`Attention belongs to the model`) — at the meta level.**
The framing note's premise is "a contributor must cross-read five layers and
then spelunk the archive." But the contributor in 2026 is increasingly an
agent. The right move is to make the corpus _machine-retrievable and
machine-summarizable_ (generated views, structured tags), not to pre-digest it
into a human-authored summary that the agent then has to trust uncritically.
Pre-digestion seizes the salience an agent should own over its own context.

Net: **Option D's tagging sub-decision is correct and load-bearing; its
hand-authored-map sub-decision is an axiom-18/axiom-3 violation waiting to
happen.** Keep the tags, generate the map.

## Part 3 — The Right Shape: Derive, Don't Author

Brewva already solved an isomorphic problem and the precedent is the model.
`docs/reference/skill-navigation.md` is _not_ hand-written; it is regenerated
from skill bodies by `script/generate-skill-navigation.ts`, with a
regenerate-and-diff fitness (`skill-navigation-fresh.fitness.test.ts`) that
fails closed if the checked-in view drifts from the source. The decision that
landed it (`derivation-direction-invariant-and-skill-navigation.md`) is
explicit: the aggregate is "a generated Tier-1 derivative, verified by
regenerate-and-diff, never a hand-written sibling."

Apply the identical pattern to the axiom ↔ rule ↔ decision graph:

```
sources of record (hand-authored, authoritative)
  design-axioms.md            (18 axioms, numbered)
  critical-rules.md           (bullets, each may end in "(axiom N)")
  anti-patterns.md            (bullets, each may end in "(axiom N)")
  decisions/*.md              (each with optional "## Axioms" section, already enforced)

  │  generate  (script/generate-axiom-enforcement.ts)
  ▼

derived view (generated, never hand-edited, regenerate-and-diff guarded)
  docs/reference/axiom-enforcement.md
    for each axiom N: { statement, enforced-by[], precedent-decisions[] }
```

This shape has five properties the hand-authored map cannot match:

1. **No second source.** The view is a pure projection. Editing a rule's
   `(axiom N)` tag and regenerating is the _only_ way the view changes. Axiom
   18 is satisfied by construction.
2. **The negative space is the gap, not a restatement.** The generator emits
   an axiom row even when its `enforced-by[]` is empty — surfacing "this axiom
   is asserted but nothing enforces it" as visible negative space. That is the
   genuinely new information, and a hand-authored map would tend to paper over
   it rather than highlight it.
3. **The precedent-decisions[] column re-grounds the archive without demoting
   it.** Each axiom row links the (at most a handful of) post-cutoff decisions
   that cited it. The 116 grandfathered records stay in the archive, untouched,
   and the view does not pretend to index them. This _is_ the demotion the
   framing note wanted — but it happens as a projection, not as a prose
   rewrite of `decisions/README.md`.
4. **Decomposability for agents.** A generated Markdown table is also a cheap
   parse target. An agent that needs "what enforces axiom 6?" gets a one-row
   answer instead of a five-doc cross-read. This is the self-learning payoff:
   the corpus becomes addressable, not just human-readable.
5. **The fitness guard writes itself.** Instead of the framing note's "assert
   the map covers every axiom and tags resolve" — which is trivially true for
   a generated map — the guard is the regenerate-and-diff that already works
   for skill-navigation. One reused mechanism, not a new one.

## Part 4 — What Stays, What Changes, What Is Deleted

| Artifact                                                                | Framing note said | This note says                     | Why                                                                                                                 |
| ----------------------------------------------------------------------- | ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `decisions/*.md` (125 files)                                            | keep              | **keep, untouched**                | already demoted in fact; write-once; 7 inbound sites; no maintenance cost (Fact A)                                  |
| `decision-axiom-citations` fitness                                      | keep              | **keep**                           | the one forcing function that is alive; do not weaken it                                                            |
| `(axiom N)` tags in rule docs                                           | add               | **add** (the load-bearing part)    | this is the real gap; rule docs never cite the axiom they serve (Fact B)                                            |
| `## Negative Space & Enforcement` in `design-axioms.md` (hand-authored) | add               | **do not add**                     | axiom-18/axiom-3 violation; second source (Part 2)                                                                  |
| `docs/reference/axiom-enforcement.md` (generated)                       | not proposed      | **add + generator + diff fitness** | the derived Tier-1 view; reuses the skill-navigation precedent (Part 3)                                             |
| `decisions/README.md` + `research/README.md` prose demotion             | strengthen        | **light touch only**               | the contract is already correct; a single sentence pointing at the generated view is enough, no "demotion ceremony" |
| New `design-anti-patterns.md` under `docs/architecture/`                | rejected          | **stay rejected**                  | agree with framing note Option A rejection                                                                          |

The deletion that matters is conceptual, not file-level: **delete the idea
that the negative space should be hand-authored.** Everything else is either
retained or derived.

## Part 5 — Refined Decision Proposal

1. **Tag the rules.** In `critical-rules.md` and `anti-patterns.md`,
   architectural bullets gain a trailing `(axiom N)` source tag. Bullets that
   descend from a Hard Invariant rather than an axiom tag the invariant. Do
   not force a tag where no axiom genuinely applies — untagged bullets are
   legitimate negative space and the generator will show them as such.
2. **Generate the negative-space view.** Add
   `script/generate-axiom-enforcement.ts` (sibling to
   `generate-skill-navigation.ts`, same discipline: build-time only, imports no
   `@brewva` package, fails closed on dangling references) emitting
   `docs/reference/axiom-enforcement.md`. One row per axiom: statement,
   enforced-by (the tagged rule bullets, which are themselves the concrete
   "what not to do"), precedent-decisions (post-cutoff decisions whose
   `## Axioms` cites it). An axiom with an empty `enforced-by` is emitted as-is
   — that is the negative space.
3. **Guard with regenerate-and-diff.** Add
   `test/fitness/docs/axiom-enforcement-fresh.fitness.test.ts` mirroring
   `skill-navigation-fresh`: regenerate to a temp buffer and fail if the
   checked-in view differs. Optionally also assert every axiom has a row and
   every `(axiom N)` tag resolves to a real axiom number — both are free given
   generation.
4. **One-sentence prose pointer, not a demotion ceremony.** In
   `decisions/README.md` and `research/README.md`, add a single line: the
   scannable "axiom → what not to do" surface is the generated
   `docs/reference/axiom-enforcement.md`; the archive remains provenance-only.
   Do not rewrite the existing framing, which is already correct.
5. **Do not author a new anti-patterns doc.** Explicitly rejected, recorded
   here so the option does not return.

## Part 6 — Relationship To The Earlier Framing Draft

An earlier framing draft occupied this same path before this deepening replaced
it in place; that draft now survives only in git history. It was a correct
_problem statement_ with a slightly over-built _solution_ (it accepted a
hand-authored map as its chosen option). This note keeps the draft's correct
parts and amends the rest:

- keeps the diagnosis intact (the linkage gap is real),
- keeps the "do not delete the archive" and "do not author a new anti-patterns
  doc" rejections intact,
- **amends the chosen option** by splitting it: the tagging sub-part is
  retained, the hand-authored-map sub-part is replaced by a generated view,
- supplies the missing evidence (Part 1) that the archive is already demoted,
  so the "demotion" work is smaller than the draft assumed,
- and grounds the amendment in axioms 18, 3, and 1 rather than in taste.

On promotion, archive this note to `decisions/`. There is no separate draft
file to delete — the replacement already happened in place.

## Part 7 — Self-Learning Reframe (The Deeper Question You Asked)

You framed this as a _self-learning and evolution_ question: the decisions
ring is heavy, you want the corpus to teach without being re-read every time,
and you want to "abstract a doc" for the anti-philosophy. The deepest answer
is that **Brewva's constitution already encodes the correct self-learning
mechanism, and the framing note was about to violate it.**

The mechanism is axiom 18's derivation direction: **authoritative state feeds
descriptive views; descriptive metadata may not feed authoritative runtime
decisions.** Lifted to docs, that reads: _the rules and axioms are
authoritative; every index, map, or "what not to do" summary is a descriptive
view and must be derived, never hand-authored as a peer._ The moment you
hand-author a negative-space map, you have created a second authority that
must be reconciled by hand forever — which is precisely the maintenance weight
you are trying to escape. The archive is not the weight; a hand-authored
summary of the archive would be.

The corollary for evolution: **the corpus compounds when it is addressable,
not when it is summarized.** 125 immutable records are an asset if each can be
retrieved by axiom, by rule, by code anchor, or by date; they are a liability
only if the only access path is "read the README and guess." The generated
`axiom-enforcement.md` is the first addressability layer. A natural second
layer (out of scope here, but worth naming) is the same generator emitting a
machine-readable sidecar (`axiom-enforcement.json`) that an agent's recall can
query — turning the archive into typed precedent rather than prose to be
skimmed. That is the self-learning loop done _in Brewva's own style_: derived,
replay-derived, advisory to the model, never a second authority.

So the answer to "is there a better way than a heavy decisions directory?" is:
the directory was never the problem; the missing _derived index_ was. Build
the index the way `skill-navigation` was built. Do not hand-author the
philosophy's negative space — let the axioms and rules generate it.

## Source Anchors

- `docs/architecture/design-axioms.md` — 18 axioms; the authoritative
  constitution the view derives from. Read by `ring-topology`,
  `platform-growth-governance` fitness; the generated view must not break
  those.
- `skills/project/shared/critical-rules.md`,
  `skills/project/shared/anti-patterns.md` — the rule docs to be tagged.
- `AGENTS.md` Hard Invariants — the gate layer; tagged as invariant-sourced.
- `docs/research/decisions/README.md` + `test/fitness/docs/decision-axiom-citations.fitness.test.ts`
  — the alive forcing function (post-cutoff `## Axioms`); the view's
  `precedent-decisions` column consumes its output.
- `docs/research/README.md` — the three-ring lifecycle this note refines.
- `script/generate-skill-navigation.ts` +
  `test/fitness/docs/skill-navigation-fresh.fitness.test.ts` +
  `docs/research/decisions/derivation-direction-invariant-and-skill-navigation.md`
  — the precedent for derived Tier-1 views; the generator is modeled on this.
- `test/fitness/docs/research-index-consistency.fitness.test.ts` — enforces
  the ≤80-line, boilerplate-banned, write-once decision shape that makes the
  archive cheap (evidence for Fact A).

## Validation Signals

- `bun run test:docs` stays green, including `markdown-links`,
  `research-index-consistency`, `ring-topology`, `ownership-grammar`,
  `platform-growth-governance`, and `skill-navigation-fresh` (the sibling
  pattern the new generator mirrors).
- The new `axiom-enforcement-fresh` fitness passes and fails closed when the
  checked-in view drifts from a regeneration.
- Manual spot check: temporarily remove a tag from a rule bullet and confirm
  the generated view moves that rule out of the axiom's `enforced-by` and the
  diff fitness fails — proving the map is derived, not authored.
- Manual spot check: confirm at least one axiom row shows an empty
  `enforced-by` as visible negative space (not suppressed).

## Promotion Criteria And Destination Docs

- The generator, the generated view, the diff fitness, the rule-doc tags, and
  the one-sentence README pointer all land and `bun run test:docs` is green.
- Because the change adds only documentation and build-time tooling — no
  runtime authority, no persisted format, no public CLI/API surface —
  promotion archives this note rather than minting a new decision record. There
  is no separate framing draft to delete; this note replaced an earlier draft at
  the same path, preserved in git history.
- Destination docs: `critical-rules.md`, `anti-patterns.md`, the two research
  READMEs, the generated `docs/reference/axiom-enforcement.md` with its
  generator and diff fitness, a `design-axioms.md` Related Docs back-link, and a
  `docs/index.md` entry.

## Surface Budget

- required authored fields: 0 -> 0
- optional authored fields: 0 -> 0
- author-facing concepts: 0 -> 1 (the generated `axiom-enforcement.md`; a
  derived view, like `skill-navigation.md`, which _reduces_ the places to look
  rather than adding a hand-authored one)
- inspect surfaces: 0 -> 0
- routing/control-plane decision points: 0 -> 0
- build-time generators: 1 -> 2 (adds `generate-axiom-enforcement.ts`,
  sibling to the existing skill-navigation generator; no runtime import)

No net required authored fields, no author-facing routing growth, no
control-plane growth, so no debt owner is required. The single new concept is
a generated index; its re-evaluation trigger is the next time an axiom is
added, retired, or a rule's tag changes — at which point regeneration is the
whole fix.
