#!/usr/bin/env python3
"""Shared Brewva skill root resolution helpers for authoring scripts."""

from __future__ import annotations

import os
from pathlib import Path


BREWVA_CONFIG_DIR_NAME = ".brewva"
BREWVA_CONFIG_FILE_NAME = "brewva.json"
SYSTEM_SKILLS_DIR_NAME = ".system"


def normalize_path_input(path_text: str) -> str:
    trimmed = path_text.strip()
    if not trimmed:
        return trimmed
    if trimmed == "~":
        return str(Path.home())
    if trimmed.startswith("~/"):
        return str(Path.home() / trimmed[2:])
    return trimmed


def resolve_maybe_absolute(path_text: str, base_dir: Path) -> Path:
    normalized = normalize_path_input(path_text)
    candidate = Path(normalized)
    if candidate.is_absolute():
        return candidate.resolve()
    return (base_dir / candidate).resolve()


def resolve_global_brewva_root(cwd: Path) -> Path:
    agent_dir = os.environ.get("BREWVA_CODING_AGENT_DIR", "").strip()
    if agent_dir:
        return (resolve_maybe_absolute(agent_dir, cwd) / "..").resolve()
    xdg_config_home = os.environ.get("XDG_CONFIG_HOME", "").strip()
    if xdg_config_home:
        return resolve_maybe_absolute(f"{xdg_config_home}/brewva", cwd)
    return (Path.home() / ".config" / "brewva").resolve()


def _has_brewva_config_root(path: Path) -> bool:
    return (path / BREWVA_CONFIG_DIR_NAME / BREWVA_CONFIG_FILE_NAME).is_file()


def _has_git_root_marker(path: Path) -> bool:
    return (path / ".git").exists()


def resolve_workspace_root(cwd: Path) -> Path:
    current = cwd.resolve()
    while True:
        if _has_brewva_config_root(current) or _has_git_root_marker(current):
            return current
        if current.parent == current:
            return cwd.resolve()
        current = current.parent


def resolve_project_brewva_root(cwd: Path) -> Path:
    return (resolve_workspace_root(cwd) / BREWVA_CONFIG_DIR_NAME).resolve()


def resolve_system_brewva_root(cwd: Path) -> Path:
    return (resolve_global_brewva_root(cwd) / "skills" / SYSTEM_SKILLS_DIR_NAME).resolve()


def resolve_bundled_skills_root(script_path: Path) -> Path:
    return script_path.resolve().parents[3]
