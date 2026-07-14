# Learning-Research Strict Protocol (scaffold)

Failure mode this scaffold counters: models either skip the precedent layer
("I already know what it says") and re-derive lessons the repository already
paid for, or anchor on the first retrieved record without checking whether it
still describes the current code. Load this when the kernel points here (a
consult is being skipped under the exception rule, or a weak-model profile is
active).

Eval contract: this scaffold earns default-loading only while the three-arm
paired eval (no-skill / kernel-only / kernel+scaffold) shows it helps the
active model tier; a strong-tier tax demotes it to on-demand.

## Strict consult checklist

- Run the consult even when the exception rule would allow skipping; record
  the result either way.
- Two query shapes minimum before concluding `no_relevant_precedent_found`:
  one by problem class, one by module/boundary. Zero results from one narrow
  query is a query-quality signal, not evidence of absence.
- For every consulted record, name one concrete file or behavior it predicts
  and check it — a precedent that predicts nothing checkable steers nothing.

## Red flags — stop and repair

If you catch yourself thinking any of these, stop, name the violated
precondition, repair it, then continue:

- "I already know what the precedent says from prior context"
- "No results means no precedent exists" (without checking query specificity)
- "I'll summarize the whole docs folder instead of targeting the query"
- "This research is taking too long, I'll skip the consult" (skipping is
  legal only with the stated-reason exception — silence is not an exception)
- Following a precedent whose described code no longer exists

## Common rationalizations

See `references/rationalizations.md` for the anti-pattern table. Rows carry
provenance (model generation and date observed); rows unfired across
consecutive calibration windows on current-tier models enter the retirement
watchlist.
