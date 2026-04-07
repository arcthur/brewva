#!/usr/bin/env bash
# resolve_github_context.sh — Detect repo, auth status, and current PR context
# Output JSON: {"repo": str, "owner": str, "authenticated": bool, "current_pr": int|null, "branch": str}
set -euo pipefail

json_error() {
  printf '{"error": "%s", "repo": null, "owner": null, "authenticated": false, "current_pr": null, "branch": null}\n' "$1"
  exit 1
}

if ! command -v gh &>/dev/null; then
  json_error "gh CLI not found"
fi

if ! command -v git &>/dev/null; then
  json_error "git not found"
fi

if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  json_error "not inside a git repository"
fi

authenticated=false
if gh auth status &>/dev/null; then
  authenticated=true
fi

branch=$(git symbolic-ref --short HEAD 2>/dev/null || echo "detached")

repo_full=""
owner=""
repo_name=""

if [ "$authenticated" = true ]; then
  repo_full=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo "")
fi

if [ -z "$repo_full" ]; then
  remote_url=$(git remote get-url origin 2>/dev/null || echo "")
  if [ -n "$remote_url" ]; then
    repo_full=$(echo "$remote_url" | sed -E 's#.*github\.com[:/]##; s/\.git$//')
  fi
fi

if [ -n "$repo_full" ]; then
  owner=$(echo "$repo_full" | cut -d/ -f1)
  repo_name=$(echo "$repo_full" | cut -d/ -f2)
fi

current_pr=null
if [ "$authenticated" = true ] && [ "$branch" != "detached" ] && [ -n "$repo_full" ]; then
  pr_number=$(gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null || echo "")
  if [ -n "$pr_number" ]; then
    current_pr=$pr_number
  fi
fi

printf '{"repo": "%s", "owner": "%s", "authenticated": %s, "current_pr": %s, "branch": "%s"}\n' \
  "$repo_name" "$owner" "$authenticated" "$current_pr" "$branch"
