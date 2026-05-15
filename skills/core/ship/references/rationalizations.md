# Common Rationalizations

| Excuse                                           | Reality                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| "Review approved, so it's shippable"             | Review is one of four gates. Check all of them.                                                             |
| "The verifier pass was mostly good"              | `inconclusive` or `fail` blocks `ready`. Partial evidence is not full evidence.                             |
| "CI is probably green by now"                    | Check. If unknown, the gate fails.                                                                          |
| "Just a one-liner, faster than switching skills" | Ship is read-only. A one-liner during ship bypasses review and verification gates. Route to implementation. |
| "We can fix it after merge"                      | That is a rollback story. Name it as a risk, not as a plan.                                                 |
