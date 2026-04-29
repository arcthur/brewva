# Common Rationalizations

| Excuse                                          | Reality                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Unit tests pass, so it works"                  | Unit tests are not QA. Real flows can fail with green unit tests.                          |
| "I read the code and it's correct"              | Reading is not execution. Run the check.                                                   |
| "Environment is too hard to set up"             | Record it as `inconclusive`. Do not fake a pass.                                           |
| "The happy path works, edge cases are unlikely" | At least one adversarial probe is mandatory. Skip it and the verdict stays `inconclusive`. |
| "Fixing it myself is faster"                    | QA does not patch product code. Hand off defects to implementation.                        |
