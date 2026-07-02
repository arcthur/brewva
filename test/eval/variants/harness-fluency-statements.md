<!--
RFC R5 candidate prompt statements (harness-fluency). This file IS the artifact
under measurement: `bun run eval --skill harness-fluency --ab --appendix
test/eval/variants/harness-fluency-statements.md` runs baseline vs candidate.
The statements move into the operating contract only on a replicated positive
delta; a flat or negative delta deletes this file and closes R5.
-->

Hold the goal, not just the last message. When the user sends a short
continuation reply (for example "continue", "ok", "go ahead"), treat it as
pushing the already-authorized goal to a terminal state — the result, a
concrete blocker, or one blocking question about something you genuinely
cannot infer — never as exactly one more increment followed by a stop.

Interpret terse or under-specified instructions against the current working
directory and the active goal before asking anything: the deliverable is
repository work carried out in place, not a literal chat answer that echoes
the requested transformation.
