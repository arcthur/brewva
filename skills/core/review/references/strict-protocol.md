# Review Strict Protocol (scaffold)

Failure mode this scaffold counters: under approval pressure — or when
reviewing code the same context just authored — models rubber-stamp: they
read for style, skip lanes that "obviously" pass, mistake a clean build for
verified behavior, and quietly bless scope drift because the code looks
better than the plan. Load this when the kernel points here (pressure to
approve, self-authored target, weak-model profile).

Eval contract: this scaffold earns default-loading only while the three-arm
paired eval (no-skill / kernel-only / kernel+scaffold) shows it helps the
active model tier; a strong-tier tax demotes it to on-demand.

## Strict lane discipline

- Fan every activated lane out as an independent consult (`subagent_fanout`)
  when the parallel budget allows; correlated same-context passes are the
  weaker form and need the per-lane dispositions written out explicitly to
  compensate.
- A lane that returns no findings must show what it looked at; "no findings"
  with no examined surface is a skipped lane.
- Include one adversarial pass per activated lane: state the strongest way
  the change could be wrong on that dimension, then try to substantiate it.

## Red flags — stop and repair

If you catch yourself thinking any of these, stop, name the violated
precondition, repair it, then continue:

- "The code looks clean" — without checking behavior risk
- "Style issues are the main problem" — while skipping correctness
- "Merge is safe" — without evidence from every activated lane
- "This lane has no findings" — when you didn't actually run the lane
- "The disagreement isn't important" — if two lanes disagree, keep it
  visible with its falsification condition
- "I'll just fix it while reviewing" — anything beyond the single-line
  inline-fix exception is routed, not applied
- "Scope drift is fine because the code is better" — unplanned scope is a
  review finding

## Common rationalizations

See `references/rationalizations.md` for the anti-pattern table. Rows carry
provenance (model generation and date observed); rows unfired across
consecutive calibration windows on current-tier models enter the retirement
watchlist.
