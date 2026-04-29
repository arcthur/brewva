# Concrete Example

Input: "Add email validation to the signup handler."

```json
{
  "implementation_targets": [
    {
      "target": "packages/brewva-gateway/src/handlers/signup.ts",
      "kind": "source",
      "owner_boundary": "gateway-signup-handler",
      "reason": "Add email format guard before credential creation."
    }
  ],
  "success_criteria": [
    "bun test test/unit/gateway/signup.unit.test.ts — covers invalid email rejection and valid email acceptance"
  ],
  "approach_simplicity_check": {
    "verdict": "acceptable",
    "speculative_features": [],
    "over_abstracted": false,
    "flags": []
  },
  "scope_declaration": {
    "will_change": ["signup handler — add email format guard before credential creation"],
    "will_not_change": ["auth flow", "session handling", "user model schema", "other form fields"]
  }
}
```
