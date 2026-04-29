# Concrete Example

Input: "Design a Telegram admin prompt with concise copy and two-step confirmation buttons."

Output:

```json
{
  "telegram_response_plan": {
    "strategy": "workflow_guided",
    "tone": "direct, low-density",
    "primary_action": "Confirm deploy to production",
    "confirmation_model": "two-step: preview then commit"
  },
  "telegram_payload": {
    "text": "Deploy v2.4.1 to production?\n\nChanges: 3 files, auth token rotation fix.\nRisk: low — no schema migration.",
    "parse_mode": null,
    "buttons": [
      [
        { "text": "Preview changes", "callback_data": "deploy_preview_v2.4.1" },
        { "text": "Cancel", "callback_data": "deploy_cancel_v2.4.1" }
      ]
    ]
  },
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```
