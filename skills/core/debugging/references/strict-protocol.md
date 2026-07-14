# Debugging Strict Protocol (scaffold)

Failure mode this scaffold counters: under time pressure or after failed
fixes, models guess-and-patch — proposing changes before tracing data flow,
retrying the same explanation with new wording, and mistaking "the symptom
moved" for "the cause was found". This protocol is the tightened form of the
kernel workflow for exactly those conditions. Load it when the kernel points
here (time pressure, two failed fix attempts, symptom-patching noticed) or
when operating on a weak-model profile.

Eval contract: this scaffold earns default-loading only while the three-arm
paired eval (no-skill / kernel-only / kernel+scaffold) shows it helps the
active model tier; a strong-tier tax demotes it to on-demand.

## Hard caps (strict mode)

The kernel's adaptive defaults tighten to fixed caps here:

- Keep at most 3 active hypotheses. More than 3 means you are enumerating,
  not investigating — collapse to the 3 with the cheapest falsification
  steps.
- Same-symptom hard stop: if two attempted explanations produced the same
  symptom with no new falsifying evidence, stop and reset the investigation
  around the three best hypotheses. Do not make a third patch-shaped guess.
- After 3 falsified hypotheses with no confirmed cause, escalate with the
  ranked record instead of inventing a fourth on the same evidence.
- Run `scripts/hypothesis_tracker.py` after each Phase 2 iteration to keep
  the externalized list well-formed (advisory lint — the numbers above are
  this protocol's caps, not the script's authority).

## Red flags — stop and repair

If you catch yourself thinking any of these, stop, name the violated
precondition, repair it, then continue:

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works" (a change without a declared
  expected observation is a guess, not a probe)
- "I don't fully understand but this might work"
- "One more fix attempt" (when the last attempt taught you nothing new)
- "It's probably X, let me fix that"
- Proposing solutions before tracing data flow
- Each fix reveals a new problem in a different place
- Repeating the same symptom after two explanation attempts
- Root-cause text that says what failed but not why it failed

## Common rationalizations

See `references/rationalizations.md` for the anti-pattern table. Rows carry
provenance (model generation and date observed); rows unfired across
consecutive calibration windows on current-tier models enter the retirement
watchlist.
