# Common Rationalizations

| Excuse                                         | Reality                                                                                                  |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| "Contract-only skeleton is a good first step"  | Skeletons without behavior cause models to hallucinate workflow.                                         |
| "Prose instructions are clearer than a script" | Models follow scripts deterministically when execution is allowed; read-only rules belong in invariants. |
| "One skill per task keeps things simple"       | Overlapping skills cause routing confusion. Territory must be exclusive.                                 |
| "150 lines is too restrictive"                 | If the body is longer, content belongs in references/, invariants/, or scripts/.                         |
| "Description can hint at the workflow"         | Models follow descriptions instead of reading the body. Trigger-only.                                    |
