# Common Rationalizations

| Excuse                                            | Reality                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| "Source code proves what happened at runtime"     | Source shows intent, artifacts show what actually executed.        |
| "The projection is close enough to authoritative" | Projections are derived views; event store is the source of truth. |
| "The gap in the trace is obvious from context"    | Obvious gaps produce wrong root causes. Name the missing artifact. |
| "Raw JSONL dump is sufficient evidence"           | Raw dumps without causal interpretation are noise, not forensics.  |
| "One session artifact tells the whole story"      | Cross-layer correlation catches what single-layer analysis misses. |
