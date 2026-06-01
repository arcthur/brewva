#!/usr/bin/env sh

set -eu

if ! git_dir="$(git rev-parse --git-dir 2>/dev/null)"; then
  exit 0
fi

repo_root="$(git rev-parse --show-toplevel)"
hook_source="$repo_root/.githooks/pre-commit"
hook_target="$(git rev-parse --git-path hooks/pre-commit)"

if [ ! -f "$hook_source" ]; then
  exit 0
fi

mkdir -p "$(dirname "$hook_target")"
cp "$hook_source" "$hook_target"
chmod +x "$hook_target"

printf 'Installed Brewva git hooks into %s\n' "$git_dir/hooks"
