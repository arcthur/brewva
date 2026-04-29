# Common Rationalizations

| Excuse                                       | Reality                                                            |
| -------------------------------------------- | ------------------------------------------------------------------ |
| "Force-push is fine on a feature branch"     | Other collaborators may have fetched. Check first.                 |
| "History rewrite makes the graph prettier"   | Prettier graphs do not justify lost rollback safety.               |
| "Dirty worktree won't affect this operation" | Stashed or uncommitted work can silently leak into commits.        |
| "I'll split the commits later"               | Later never comes. Split now or commit to the monolith explicitly. |
