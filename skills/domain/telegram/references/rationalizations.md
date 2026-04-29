# Common Rationalizations

| Excuse                                     | Reality                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| "Slightly over 4096 chars is fine"         | Telegram silently drops or truncates. There is no graceful overflow.                  |
| "More buttons means more choice"           | More buttons means more cognitive load on a small screen. Fewer, clearer.             |
| "Skip validation for simple messages"      | Simple messages have constraints too. Validation is fast. Run it.                     |
| "Copy this web UI pattern"                 | Web patterns assume mouse, large screen, and sustained attention. Telegram has none.  |
| "Confirmation is overkill for this action" | If the action mutates state, the user deserves to see what happens before it happens. |
