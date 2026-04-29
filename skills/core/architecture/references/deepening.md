# Deepening Reference

Deepening turns a shallow module into a deeper one by reducing caller burden
and concentrating future change behind a better interface. It is not the same
as adding a layer.

## Dependency Categories

### 1. In-Process

The module depends only on pure logic, local memory, value objects, or
deterministic state.

- Usually safe to deepen.
- Tests should call the new interface directly.
- Avoid exposing helper seams purely for tests.

### 2. Local-Substitutable

The dependency has a faithful local stand-in: temp directories, in-memory
stores, fake clocks, local queues, or deterministic provider fixtures.

- Deepen when the stand-in preserves the real dependency's semantics.
- Keep the stand-in behind the module interface where possible.
- Tests should verify behavior, not the stand-in wiring.

### 3. Remote But Owned

The dependency is remote, but the team owns both sides: internal HTTP/gRPC,
queue workers, hosted runtime services, or internal control-plane surfaces.

- Define a seam at the local ownership point.
- Use production adapters for real transport and in-memory or fixture adapters
  for tests.
- Preserve protocol and failure semantics in the interface contract.

### 4. True External

The dependency is outside local ownership: third-party APIs, hosted providers,
external CLIs, SaaS systems, or user-controlled environments.

- Inject the dependency behind a port-like seam only when callers gain
  immediate leverage.
- Keep provider-specific errors, retries, rate limits, and credentials out of
  callers.
- Use mock or fixture adapters for tests, but keep the public module interface
  behavior-oriented.

## Seam Discipline

- Do not expose an internal seam only because a test wants to reach it.
- Do not create a seam for imagined future adapters unless it reduces current
  caller knowledge.
- One adapter is a hypothetical seam. Require locality or testability evidence.
- Treat two adapters as real. Compare whether they share a stable interface or
  whether the abstraction is hiding incompatible concepts.
- Prefer a seam at the point where policy changes, not where code happens to be
  easiest to extract.

## Friction Signals

Strong signals include:

- bouncing across many small modules for one domain concept
- pass-through modules whose interface is nearly as complex as their implementation
- helper extraction that leaves orchestration bugs in the caller
- tests that must know internal order, timing, retries, config, or error modes
- duplicated call-site knowledge about dependency setup, recovery, or validation
- a seam that exists only as a name but has one concrete behavior and no caller leverage

## Testing Through The Deepened Interface

Good deepening changes the test shape:

- old shallow unit tests that pin helper order become module-interface tests
- orchestration tests assert outcomes, retries, recovery, or emitted artifacts
- adapter tests focus on protocol conformance, not business policy
- callers need fewer mocks because the module owns dependency setup

If tests become more coupled after the refactor, the module probably became
shallower even if the file graph looks cleaner.

## Rejection Criteria

Reject a candidate when:

- deleting the proposed module removes complexity instead of scattering it
- the proposed interface mostly forwards parameters to the implementation
- callers still need to know ordering, retries, config, or provider quirks
- tests require new public hooks that production callers do not need
- the change mostly renames files or moves code without changing caller burden

## Candidate Shape

For each candidate include:

- files read and the named module
- current interface burden on callers
- proposed deepening direction, without final interface shape
- dependency category and likely adapter posture
- locality gain: which future change or bug becomes concentrated
- leverage gain: what callers no longer need to know
- test improvement: what existing tests could move to the module interface
- risks, open questions, and project-decision conflicts
