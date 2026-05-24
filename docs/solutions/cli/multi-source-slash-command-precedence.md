---
id: sol-2026-05-24-multi-source-slash-command-precedence
title: Multi-source slash commands resolve through one shell registry
status: active
problem_kind: feature
module: brewva-cli
boundaries:
  - cli.shell_command_provider
  - cli.shell_command_registry
  - cli.file_backed_commands
source_artifacts:
  - implementation_plan
  - verification_evidence
tags:
  - slash-commands
  - cli
  - provenance
  - capability-boundary
updated_at: 2026-05-24
---

# Multi-Source Slash Command Precedence

## Context

Project and user command files are valuable portability hooks, but they become
dangerous if each ecosystem gets a separate registry or if command files can
shadow built-ins without explanation.

## Guidance

Load all file-backed slash commands through `ShellCommandProvider`. Keep the
precedence deterministic:

1. built-in Brewva
2. project `.brewva/commands`
3. user `~/.brewva/commands`
4. project `.claude/commands`
5. user `~/.claude/commands`
6. project `.codex/commands`
7. user `~/.codex/commands`
8. project `.opencode/commands`
9. user `~/.opencode/commands`

Built-ins are not replaceable. Duplicate lower-precedence commands remain
visible as shadowed diagnostics with provider and path provenance, but slash
lookup resolves to the first owner.

Markdown command files are prompt templates, not authority grants. Frontmatter
that asks for tools, permissions, MCP, or capabilities fails closed.

## Why This Matters

Users can reuse existing command libraries while Brewva preserves one shell
control plane, one completion/help surface, and one capability boundary.

## When To Apply

Apply this pattern whenever adding another command source. Register a provider
with provenance instead of creating a parallel slash registry.

## References

- `packages/brewva-cli/src/shell/commands/command-provider.ts`
- `packages/brewva-cli/src/shell/commands/file-command-provider.ts`
- `docs/reference/commands/interactive.md`
