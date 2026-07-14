# Common Rationalizations

These rows predate v3 and have no recoverable model-generation or observation-date
metadata. They are retained honestly as `legacy-unattributed`, are not independent
behavioral evidence, and remain `retirement-review-required` until a future observed
occurrence supplies real provenance. The canonical rule column is authoritative;
the table does not create additional caps, stops, or exceptions.

| Excuse                                  | Reality                                                                                            | Canonical rule                                 | Provenance                                   | Lifecycle                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- | -------------------------- |
| "Issue is simple, don't need process"   | Match the investigation depth to the evidence while preserving the confirmed-cause boundary.       | `debugging.confirmed-cause-before-shipped-fix` | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "Emergency, no time for process"        | Use the recorded mitigation exception when time pressure prevents causal confirmation.             | `debugging.confirmed-cause-before-shipped-fix` | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "Just try this first, then investigate" | A patch-shaped probe follows the scaffold's declared-probe evidence contract.                      | `debugging.strict-declared-probes-only`        | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "I see the problem, let me fix it"      | A plausible mechanism is not the observation needed to exclude live rivals.                        | `debugging.strict-causal-claim-integrity`      | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "One more fix attempt"                  | A repeated attempt needs fresh evidence; counts alone do not establish an architectural cause.     | `debugging.fresh-evidence-per-attempt`         | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "Multiple fixes at once saves time"     | A probe should preserve the observation needed to attribute the result to its declared hypothesis. | `debugging.strict-declared-probes-only`        | legacy-unattributed (model/date unavailable) | retirement-review-required |
| "Same symptom, different guess"         | Use the scaffold reset only under the evidence conditions stated by its canonical rule.            | `debugging.strict-same-symptom-reset`          | legacy-unattributed (model/date unavailable) | retirement-review-required |
