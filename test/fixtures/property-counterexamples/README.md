# Property Counterexamples

Counterexamples discovered by fast-check must be committed when they represent a real bug class.

Rules:

- One file per property id.
- Keep the shrunk value, seed, path, and a one-sentence bug class.
- Tests must import these examples through the property test's `examples` option.
- Do not auto-write files during blocking CI.
- Use `BREWVA_PROPERTY_MODE=fuzz` for discovery and the default CI mode for regression.
