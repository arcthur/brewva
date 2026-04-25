# Exec Threat Model

## Scope

This document covers Brewva-managed shell execution through `exec`,
`local_exec_readonly`, BoxLite-backed box routing, explicit host execution, and
related audit events.
It does not cover arbitrary shell use outside Brewva or external operators that
run commands directly on the host.

## Assets

- workspace source files and task target roots
- credential vault values and resolved tool environment bindings
- runtime receipts, event tape, WAL recovery state, and proposal evidence
- host filesystem and network access exposed by explicit operator policy

## Trust Boundaries

`exec` crosses three boundaries:

- `virtual_readonly`: command-policy accepted exploration. It can read target
  roots and returns `backend: "virtual_readonly"`, but it is not verification
  evidence.
- `box`: isolated stateful real execution. It can produce build/test evidence
  when the command actually ran in the BoxLite-backed box and emitted receipts.
- `host`: explicit high-risk effectful execution. It requires operator policy,
  effect admission, and redacted audit events.

There is no automatic host fallback. `security.execution.backend` is either
`box` or `host`; strict mode rejects `host`.

## Threats

- command substitution hides writes or network calls inside a read-looking
  command
- process substitution or redirection writes to filesystem or leaks secrets
- command options mutate files (`sed -i`, `find -delete`, `find -exec`) or run
  nested programs (`rg --pre`, `xargs sh -c`)
- shell wrappers obscure the primary command from deny lists and audit
- explicit URLs smuggle external network access into shell arguments
- box runtime outages or missing `/dev/kvm` accidentally downgrade to host execution
- audit payloads capture raw command, raw env, or secret-bearing error text
- background readonly execution escapes the virtual backend and becomes
  unmanaged process state
- prototype-polluting environment keys alter object behavior before process
  launch
- unbounded readonly output or implicit whole-workspace scans exhaust local
  resources
- symlinks or special files turn a read-looking command into an escape from the
  task target root
- stateful box compromise persists for the whole session/task box lifetime

## Controls

- `packages/brewva-runtime/src/security/command-policy.ts` is the shell
  semantic classifier for `exec`.
- The read-only grammar is intentionally small: read/search/data commands,
  simple argv, and pipelines only.
- Command policy applies static limits before execution, including command
  length, argument count, argument length, pipeline width, and explicit network
  target count.
- Unsupported shell features fail closed for `local_exec_readonly`.
- Deployment boundary policy remains responsible for filesystem roots,
  command deny lists, and network allowlists.
- `exec.*` and `box.*` events record `commandHash`, `commandRedacted`, and structured
  `commandPolicy`, never raw command/env values.
- The `virtual_readonly` backend materializes explicit relative path arguments
  into a temporary workspace subset, rejects unsafe path materialization, drops
  the subset after execution, enforces a default timeout, and terminates on
  output limit breach.
- Environment overlays are null-prototype objects; invalid keys and
  prototype-pollution keys are dropped before process launch.
- Box runtime failures emit `box.exec.failed` or `box.bootstrap.failed` and do
  not downgrade to host. Host and virtual-readonly routing failures emit
  `exec.failed`.
- `process` manages explicit host background sessions; box detached execution
  is identified by `(box_id, execution_id)`.
- Box detached execution is reattached through Brewva supervisor metadata inside
  the box when the BoxLite SDK does not expose durable execution lookup.
- Stateful boxes must be scoped, snapshotted, and garbage-collected as durable
  execution state, not treated as disposable per-command state.

## Scenario Verdicts

| Scenario                           | Verdict                     | Control                                                                 |
| ---------------------------------- | --------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `cat package.json                  | head -n 1`                  | allow as exploration                                                    | readonly grammar plus materialized file subset |
| `rg needle packages test`          | allow as exploration        | explicit relative directories materialized into temp workspace          |
| `rg needle`                        | block from virtual readonly | implicit workspace scan lacks finite materialization target             |
| `find . -type f`                   | block from virtual readonly | whole-root materialization is not accepted as an implicit default       |
| `cat /etc/hosts`                   | block from virtual readonly | absolute path materialization is unsafe                                 |
| `cat ../secret`                    | block from virtual readonly | parent-relative path escape                                             |
| `cat $(pwd)/package.json`          | block                       | command substitution                                                    |
| `cat <(printf hi)`                 | block                       | process substitution                                                    |
| `cat package.json > /tmp/out`      | block                       | write redirection                                                       |
| `sed -i s/a/b/ package.json`       | block                       | mutation option                                                         |
| `find packages -exec rm {} ;`      | block                       | nested execution option                                                 |
| `rg --pre cat needle .`            | block                       | preprocessor execution option                                           |
| `xargs sh -c 'cat "$1"'`           | block                       | shell wrapper through xargs                                             |
| `tail -f package.json`             | block                       | unbounded follow option                                                 |
| `curl https://example.com`         | effectful                   | external network command; requires normal admission and boundary policy |
| `rg https://example.com README.md` | block from readonly         | explicit URL target removes readonly eligibility                        |
| box runtime unavailable            | block                       | fail-closed backend routing                                             |
| env key `__proto__=x`              | drop key                    | null-prototype env overlay and dangerous-key filter                     |
| symlink to outside target root     | block from virtual readonly | materialization rejects symlink escape                                  |

## Evidence Semantics

`virtual_readonly` output can support exploration and later decisions, but it
must not be cited as build, test, or deployment verification. Verification
claims need box execution or explicit host execution plus the normal
effectful receipts.

## Stateful Box Delta

The previous short-lived execution model bounded filesystem contamination and
secret exposure to one command. Stateful boxes deliberately trade that for
faster, more realistic agent workspaces. The blast radius is therefore the
entire session/task box lifetime:

- package installs, generated files, credentials, and process state can persist
  across commands
- snapshot-before-dangerous-write policy is required when action policy marks a
  command as high-risk
- `session_box` in the rebuildable session index is a derived view only; the
  event tape remains the replay authority

## Expansion Rules

New commands or options should be added fixture-first:

- one accepted fixture for the exact intended readonly behavior
- option-smuggling fixtures for mutation and nested execution
- network target fixtures when URLs or hostnames can appear
- event/audit assertions proving no raw command, raw env, or secret value is
  recorded
