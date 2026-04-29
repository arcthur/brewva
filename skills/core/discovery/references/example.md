# Concrete Example

Input: "I want to build a daily briefing app for my calendar."

Output:

```json
{
  "problem_frame": "Morning calendar review is manual and slow. Users open 2-3 apps to understand their day, miss conflicts, and lack a single surface that prioritizes what matters. The real problem is decision-ready daily context, not a new app.",
  "user_pains": [
    {
      "pain": "Checking calendar, email, and tasks separately every morning",
      "severity": "high",
      "workaround": "Manual tab-switching routine that takes 10-15 minutes"
    },
    {
      "pain": "Missing scheduling conflicts until they happen",
      "severity": "medium",
      "workaround": "None — discovered reactively"
    }
  ],
  "scope_recommendation": "Build now: a read-only morning digest that pulls calendar events and flags conflicts. Defer: task integration, email triage, AI summarization. Non-goals: full calendar replacement, meeting scheduling.",
  "design_seed": "Single daily digest endpoint that reads calendar events for the next 12 hours, detects time overlaps, and renders a priority-ordered briefing. No write operations in v1.",
  "open_questions": [
    {
      "question": "Which calendar provider(s) must be supported in the first wedge?",
      "why_it_matters": "Provider choice determines auth complexity and time-to-first-value"
    },
    {
      "question": "Is the briefing push-based (notification) or pull-based (open app)?",
      "why_it_matters": "Push requires background scheduling infrastructure that may be premature"
    }
  ]
}
```
