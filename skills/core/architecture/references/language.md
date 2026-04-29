# Architecture Language

Use this vocabulary exactly when evaluating architecture quality. The goal is
to keep architectural judgment tied to concrete caller burden and future
maintainer leverage.

## Vocabulary

- **Module**: anything with an interface and an implementation. A module may be
  a function, class, package, CLI command, workflow, queue consumer, or runtime
  capability.
- **Interface**: everything a caller must know to use the module correctly:
  types, invariants, ordering, config, error modes, retries, timing, resource
  cost, persistence behavior, and performance expectations. It is not only the
  type signature.
- **Implementation**: the code and private decisions inside the module.
- **Depth**: leverage provided by the interface. A deep module hides
  substantial behavior behind a small, stable interface. A shallow module makes
  the caller understand nearly as much as the implementation.
- **Seam**: the place where an interface lets behavior vary without editing the
  caller in place.
- **Adapter**: a concrete implementation that satisfies a seam.
- **Leverage**: the benefit a caller receives from the module. High leverage
  means the caller does less work and knows fewer details.
- **Locality**: the maintainer benefit of the module. Good locality means a
  future change, bug, or policy update is concentrated in one place.

## Principles

- Depth is a property of the interface, not the implementation. A complicated
  implementation can still be shallow if callers must know the same complexity.
- The interface is the test surface. Durable tests should assert observable
  behavior through the module, not internal helper order.
- One adapter is a hypothetical seam. Two adapters make the seam real. A
  one-adapter seam can still be useful, but it must be justified by immediate
  locality or testability rather than future flexibility.
- The deletion test separates deep modules from pass-through layers: if deleting
  the module removes complexity, it was likely shallow; if deleting it scatters
  the same knowledge across callers, it was carrying depth.
- Prefer the language of modules, interfaces, seams, adapters, leverage, and
  locality. Avoid vague architecture labels unless the repository itself uses
  them as public terms.

## Output Discipline

Every architecture claim should answer three questions:

1. Which module is being judged?
2. What does its interface force callers to know?
3. Which future change or bug becomes more local after the proposed deepening?
