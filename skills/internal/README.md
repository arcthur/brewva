# Internal Skills

`skills/internal/` is reserved for runtime-owned phase documentation.

Current phase ownership still lives in code:

- compose-style planning: chain planner + cascade services
- verification: `runtime.ops.verification.*`, `runtime.kernel` receipts, and `VerificationService`
- finishing: `SessionLifecycleService`
- recovery: continuity policy, scheduler recovery, and Recovery WAL recovery

This directory exists so future structured internal phase docs can live beside
the public capability catalog without reintroducing the old lifecycle-skill taxonomy.
