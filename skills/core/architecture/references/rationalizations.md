# Common Rationalizations

| Excuse                                               | Reality                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| "More layers will make the codebase more modular"    | A shallow layer increases interface burden without adding leverage.     |
| "We should extract this for reuse"                   | Reuse without locality often spreads knowledge instead of hiding it.    |
| "A factory makes this testable"                      | A factory is only useful if tests can assert behavior through the seam. |
| "The interface can be refined during implementation" | Candidate selection needs interface pressure before execution planning. |
| "One adapter proves the seam"                        | One adapter is hypothetical; two adapters make the seam real.           |
