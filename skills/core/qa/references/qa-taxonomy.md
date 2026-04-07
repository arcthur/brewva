# QA Finding Taxonomy

## Severity Levels

| Severity     | Definition                                                                       | Ship Impact                                                   |
| ------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **critical** | Data loss, security breach, complete feature failure, crash                      | Blocks release. Must fix before merge.                        |
| **high**     | Core flow broken, major UX regression, silent data corruption                    | Blocks release unless documented workaround exists.           |
| **medium**   | Secondary flow broken, cosmetic regression in primary flow, degraded performance | Should fix before release. May ship with explicit acceptance. |
| **low**      | Minor cosmetic issue, non-blocking edge case, improvement opportunity            | Ship. Track for follow-up.                                    |

## Categories

| Category          | Scope                               | Examples                                                         |
| ----------------- | ----------------------------------- | ---------------------------------------------------------------- |
| **functional**    | Core behavior correctness           | Button does nothing, API returns wrong data, state not persisted |
| **visual**        | Layout, styling, rendering          | Overflow, misalignment, wrong color, broken responsive layout    |
| **ux**            | Interaction quality                 | Missing loading state, no error feedback, confusing flow order   |
| **content**       | Text, labels, messaging             | Typo in error message, misleading label, missing translation     |
| **performance**   | Speed, responsiveness, resource use | Slow page load, memory leak, excessive network calls             |
| **console**       | Runtime warnings and errors         | Unhandled promise rejection, deprecation warning, stack trace    |
| **accessibility** | Assistive technology support        | Missing alt text, broken keyboard nav, low contrast              |

## Combining Severity and Category

Use `severity:category` as the canonical finding tag, e.g. `critical:functional`,
`medium:visual`, `low:content`.

A single finding has exactly one severity and one category. If a finding spans
multiple categories, split it into separate findings.
