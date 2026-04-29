# Common Rationalizations

| Excuse                                       | Reality                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| "Change is small, skip scope check"          | Small changes drift into large ones. The script takes seconds.                                                            |
| "Tests passed last time, skip re-run"        | Last time is not this time. Fresh evidence or no completion claim.                                                        |
| "Cleanup while I'm here saves a future PR"   | Incidental cleanup obscures the real diff and blocks review.                                                              |
| "Mode doesn't matter for this"               | Wrong mode means wrong verification — a `safe` change verified as `effectful` skips the rollback gate. Pick deliberately. |
| "Root cause is probably right, start coding" | Probably is not confirmed. Use debugging skill first.                                                                     |
| "I'll verify after I finish all edits"       | Batch verification hides which edit broke what. Verify incrementally.                                                     |
