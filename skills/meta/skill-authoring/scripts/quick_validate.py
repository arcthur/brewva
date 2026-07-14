#!/usr/bin/env python3
"""Minimal validator for SkillCard authoring."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


SKILL_CARD_FIELDS = {
    "name",
    "description",
    "selection",
    "references",
    "scripts",
    "invariants",
}
REMOVED_AUTHORITY_FIELDS = {
    "routing",
    "intent",
    "effects",
    "resources",
    "execution_hints",
    "consumes",
    "requires",
    "composable_with",
    "stability",
    "budget",
    "tools",
    "dispatch",
    "heuristics",
    "license",
    "compatibility",
    "source_name",
    "source_category",
    "forked_from",
    "forked_at",
    "tool",
}
SELECTION_FIELDS = {"when_to_use", "path_globs"}
STRING_ARRAY_FIELDS = {"references", "scripts", "invariants"}
PROJECT_GUIDANCE_STRENGTHS = {"invariant", "workflow_gate", "preference", "lookup"}
CONVENTION_KIND_RETIREMENT = {
    "project_fact": "auto_decay_allowed",
    "user_preference": "auto_decay_allowed",
    "style_rule": "auto_decay_allowed",
    "workflow_rule": "review_only",
    "routing_rule": "review_only",
    "verification_rule": "review_only",
    "permission_rule": "non_retirable_without_owner",
    "safety_boundary": "pinned",
    "compliance_rule": "pinned",
}
RETIREMENT_SENSITIVITIES = set(CONVENTION_KIND_RETIREMENT.values())
# v3: Red Flags are scaffold material under references/, no longer a required
# kernel section. Core/domain kernels still anchor on the Iron Law.
V3_REQUIRED_SECTIONS_CORE_DOMAIN = {"## The Iron Law"}
V3_REQUIRED_SECTIONS_ALL = {"## When to Use", "## Workflow", "## Stop Conditions"}
V3_BODY_LINE_LIMIT = 150
RULE_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "references" / "rule-manifest-schema.json"
RULE_SCHEMA = json.loads(RULE_SCHEMA_PATH.read_text(encoding="utf8"))
RULE_TIERS = set(RULE_SCHEMA["tiers"])
RULE_ID_PATTERN = re.compile(RULE_SCHEMA["ruleIdPattern"])
RULE_BULLET_PATTERN = re.compile(RULE_SCHEMA["ruleBulletPattern"])
EXCEPTION_EVIDENCE_MARKER = RULE_SCHEMA["exceptionEvidenceMarker"]
CANONICAL_EXAMPLE_REFERENCE = (
    "See `references/example.md` for the grounded example output shape."
)
WORKFLOW_LEAK_PATTERNS = [
    re.compile(r"\breproducе?\b.*\brank\b.*\bhypothes", re.IGNORECASE),
    re.compile(r"\bstructured delegation\b", re.IGNORECASE),
    re.compile(r"\btry to break\b", re.IGNORECASE),
    re.compile(r"\bconvert.*into.*handoff\b", re.IGNORECASE),
    re.compile(r"\bturn.*into.*plan\b", re.IGNORECASE),
    re.compile(r"\bfan[- ]?out\b", re.IGNORECASE),
    re.compile(r"\breproduce.*rank.*confirm\b", re.IGNORECASE),
    re.compile(r"\banti[- ]?herd checks\b", re.IGNORECASE),
]


def is_project_guidance_file(path: Path) -> bool:
    resolved = path.resolve()
    return (
        resolved.is_file()
        and resolved.suffix == ".md"
        and len(resolved.parts) >= 3
        and resolved.parts[-3:-1] == ("project", "shared")
    )


def is_overlay_skill(skill_dir: Path) -> bool:
    parts = skill_dir.resolve().parts
    return len(parts) >= 3 and parts[-3:-1] == ("project", "overlays")


def derive_category(skill_dir: Path) -> str | None:
    parts = skill_dir.resolve().parts
    if is_overlay_skill(skill_dir):
        return "overlay"
    if "skills" not in parts:
        return None
    index = parts.index("skills")
    if len(parts) <= index + 1:
        return None
    return parts[index + 1]


def find_skill_root(skill_dir: Path) -> Path | None:
    parts = skill_dir.resolve().parts
    if "skills" not in parts:
        return None
    index = parts.index("skills")
    return Path(*parts[: index + 1])


def validate_string_array_value(value: object, label: str) -> tuple[bool, str | None]:
    if not isinstance(value, list):
        return False, f"Field '{label}' must be an array"
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            return False, f"Field '{label}[{index}]' must be a non-empty string"
    return True, None


def validate_string_array(frontmatter: dict[str, object], key: str) -> tuple[bool, str | None]:
    value = frontmatter.get(key)
    if value is None:
        return True, None
    return validate_string_array_value(value, key)


def validate_positive_number(
    value: object, label: str, minimum: int
) -> tuple[bool, str | None]:
    if not isinstance(value, (int, float)) or int(value) < minimum:
        return False, f"Field '{label}' must be a number >= {minimum}"
    return True, None


def validate_selection(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    category = derive_category(skill_dir)
    selection = frontmatter.get("selection")
    if selection is None:
        return True, None
    if category in {"meta", "internal"}:
        return False, f"{category} skills cannot declare selection hints"
    if not isinstance(selection, dict):
        return False, "Field 'selection' must be an object"
    if "whenToUse" in selection:
        return False, "Field 'selection.whenToUse' has been removed; use 'selection.when_to_use'"
    if "paths" in selection:
        return False, "Field 'selection.paths' has been removed; use 'selection.path_globs'"

    unexpected_keys = set(selection.keys()) - SELECTION_FIELDS
    if unexpected_keys:
        return False, (
            "Unexpected key(s) in 'selection': "
            + ", ".join(sorted(unexpected_keys))
        )

    when_to_use = selection.get("when_to_use")
    if when_to_use is not None and (
        not isinstance(when_to_use, str) or not when_to_use.strip()
    ):
        return False, "Field 'selection.when_to_use' must be a non-empty string"

    if "path_globs" in selection:
        ok, message = validate_string_array_value(
            selection["path_globs"], "selection.path_globs"
        )
        if not ok:
            return ok, message

    if when_to_use is None and not selection.get("path_globs"):
        return False, (
            "Field 'selection' must declare at least one of: "
            "when_to_use, path_globs"
        )
    return True, None


def validate_project_guidance(path: Path) -> tuple[bool, str]:
    content = path.read_text(encoding="utf8").replace("\r\n", "\n")
    if content.startswith("\ufeff"):
        content = content[1:]
    if not re.match(r"^---[ \t]*\n", content):
        return False, "No project guidance metadata frontmatter found"

    match = re.match(r"^---[ \t]*\n(.*?)\n---[ \t]*(?:\n|$)", content, re.DOTALL)
    if not match:
        return False, "Invalid project guidance frontmatter format"

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return False, f"Invalid YAML in project guidance frontmatter: {exc}"
    if not isinstance(frontmatter, dict):
        return False, "Project guidance frontmatter must be a YAML dictionary"

    allowed_keys = {
        "strength",
        "scope",
        "convention_kind",
        "retirement_sensitivity",
        "owner",
    }
    unexpected_keys = set(frontmatter.keys()) - allowed_keys
    if unexpected_keys:
        return False, (
            "Unexpected key(s) in project guidance frontmatter: "
            + ", ".join(sorted(unexpected_keys))
        )

    strength = frontmatter.get("strength")
    if strength not in PROJECT_GUIDANCE_STRENGTHS:
        return False, (
            "Field 'strength' must be one of: "
            + " | ".join(sorted(PROJECT_GUIDANCE_STRENGTHS))
        )

    scope = frontmatter.get("scope")
    if not isinstance(scope, str) or not scope.strip():
        return False, "Field 'scope' must be a non-empty string"

    convention_kind = frontmatter.get("convention_kind")
    if convention_kind not in CONVENTION_KIND_RETIREMENT:
        return False, "Field 'convention_kind' must be a known convention kind"

    retirement_sensitivity = frontmatter.get("retirement_sensitivity")
    if retirement_sensitivity not in RETIREMENT_SENSITIVITIES:
        return False, (
            "Field 'retirement_sensitivity' must be one of: "
            + " | ".join(sorted(RETIREMENT_SENSITIVITIES))
        )

    expected_retirement = CONVENTION_KIND_RETIREMENT[convention_kind]
    if retirement_sensitivity != expected_retirement:
        return False, (
            "Field 'retirement_sensitivity' must match convention_kind default: "
            + expected_retirement
        )

    owner = frontmatter.get("owner")
    if owner is not None and (not isinstance(owner, str) or not owner.strip()):
        return False, "Field 'owner' must be a non-empty string when provided"
    if retirement_sensitivity in {"non_retirable_without_owner", "pinned"} and not owner:
        return False, (
            "Field 'owner' is required for pinned or non-retirable convention guidance"
        )

    return True, "Project guidance is valid!"


def extract_body_section(body: str, heading: str) -> str | None:
    lines = body.split("\n")
    start = next((i for i, line in enumerate(lines) if line.strip() == heading), None)
    if start is None:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if re.match(r"^##\s+", lines[index] or ""):
            end = index
            break
    return "\n".join(lines[start + 1 : end])


def validate_rules_manifest(
    body: str, skill_name: str, seen_rule_ids: set[str] | None = None
) -> tuple[bool, str | None]:
    """Validate the optional `## Rules` manifest block (v3 rule grammar).

    Absent section: valid (skills migrate incrementally). Present section:
    every bullet must be `- \\`<ruleId>\\` (<tier>) — <statement>` with a
    known tier, and controlled-exception rules must name their exception
    evidence class.
    """
    rules_heading_count = sum(
        1 for line in body.split("\n") if line.strip() == "## Rules"
    )
    if rules_heading_count > 1:
        return False, "Rules section must appear at most once"

    section = extract_body_section(body, "## Rules")
    if section is None:
        return True, None

    bullets: list[str] = []
    current: list[str] = []
    for line in section.split("\n"):
        if line.startswith("- `"):
            if current:
                bullets.append(" ".join(current))
            current = [line.strip()]
        elif not line.strip():
            continue
        elif line.startswith("  ") and current:
            current.append(line.strip())
        else:
            return False, f"Rules section contains a non-rule line: '{line.strip()}'"
    if current:
        bullets.append(" ".join(current))

    if not bullets:
        return False, "Rules section is present but declares no rules"

    seen = seen_rule_ids if seen_rule_ids is not None else set()
    for bullet in bullets:
        match = RULE_BULLET_PATTERN.match(bullet)
        if not match:
            return False, (
                "Rule bullet must match '- `<ruleId>` (<tier>) — <statement>', got: "
                + bullet[:100]
            )
        rule_id, tier, statement = match.groups()
        if not RULE_ID_PATTERN.fullmatch(rule_id):
            return False, (
                f"Rule id '{rule_id}' must be '<skill>.<rule-slug>' "
                "(kebab-case segments joined by dots)"
            )
        if not rule_id.startswith(f"{skill_name}."):
            return False, (
                f"Rule id '{rule_id}' must be prefixed with the skill name "
                f"'{skill_name}.'"
            )
        if rule_id in seen:
            return False, f"Duplicate rule id '{rule_id}'"
        seen.add(rule_id)
        if tier not in RULE_TIERS:
            return False, (
                f"Rule '{rule_id}' has unknown tier '{tier}' "
                f"(allowed: {', '.join(sorted(RULE_TIERS))})"
            )
        if tier == "controlled-exception":
            if EXCEPTION_EVIDENCE_MARKER not in statement:
                return False, (
                    f"Rule '{rule_id}' is controlled-exception but names no "
                    f"'{EXCEPTION_EVIDENCE_MARKER}' clause"
                )
            evidence = statement.split(EXCEPTION_EVIDENCE_MARKER, 1)[1].strip()
            if not evidence:
                return False, (
                    f"Rule '{rule_id}' has an empty '{EXCEPTION_EVIDENCE_MARKER}' clause"
                )
    return True, None


def validate_v3_doctrine(
    frontmatter: dict[str, object],
    content: str,
    skill_dir: Path,
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    category = derive_category(skill_dir)
    match = re.match(r"^---\n.*?\n---\n(.*)", content, re.DOTALL)
    if not match:
        return True, None
    body = match.group(1)

    skill_name = frontmatter.get("name")
    if not isinstance(skill_name, str) or not skill_name:
        return False, "Skill name is required before validating Rules"
    seen_rule_ids: set[str] = set()
    ok, message = validate_rules_manifest(body, skill_name, seen_rule_ids)
    if not ok:
        return False, message
    strict_protocol = skill_dir / "references" / "strict-protocol.md"
    if strict_protocol.is_file():
        ok, message = validate_rules_manifest(
            strict_protocol.read_text(encoding="utf8"), skill_name, seen_rule_ids
        )
        if not ok:
            return False, f"references/strict-protocol.md: {message}"

    # Overlays are delta documents, but any Rules they declare still enter the
    # same receipt namespace as base skills. Skip full-kernel doctrine only
    # after validating that shared grammar.
    if overlay:
        return True, None

    description = frontmatter.get("description", "")
    if isinstance(description, str):
        for pattern in WORKFLOW_LEAK_PATTERNS:
            if pattern.search(description):
                return (
                    False,
                    f"Description leaks workflow methodology (matched: {pattern.pattern}). "
                    "Description must contain trigger conditions only, never workflow summary.",
                )

    body_lines = [line for line in body.split("\n") if line.strip()]
    if len(body_lines) > V3_BODY_LINE_LIMIT:
        return (
            False,
            f"SKILL.md body has {len(body_lines)} non-empty lines (limit: {V3_BODY_LINE_LIMIT}). "
            "Move heavy content to references/.",
        )

    for section in V3_REQUIRED_SECTIONS_ALL:
        if section not in body:
            alt = section.replace("## When to Use", "## Trigger")
            if alt not in body and section not in body:
                return False, f"Missing required v3 section: '{section}' (or equivalent)"

    if category in {"core", "domain"}:
        for section in V3_REQUIRED_SECTIONS_CORE_DOMAIN:
            if section not in body:
                return False, f"Missing required v3 section for {category} skill: '{section}'"

    if category in {"core", "domain"}:
        phase_headers = re.findall(r"^###\s+Phase\s+\d+", body, re.MULTILINE)
        if len(phase_headers) >= 2:
            failure_indicators = [
                "**If ",
                "**If not",
                "**If any",
                "**If the",
                "If not reproducible",
                "If any check fails",
                "If validation fails",
                "If reproducible",
            ]
            has_failure_branch = any(ind in body for ind in failure_indicators)
            if not has_failure_branch:
                return (
                    False,
                    "Workflow has multiple phases but no explicit failure branches.",
                )

    example_match = re.search(
        r"^## (?:Concrete )?Example\b.*?\n(.*?)(?=^## |\Z)",
        body,
        re.DOTALL | re.MULTILINE,
    )
    if example_match:
        example_body = example_match.group(1).strip()
        if example_body == CANONICAL_EXAMPLE_REFERENCE:
            return True, None
        example_content_lines = [line for line in example_body.split("\n") if line.strip()]
        if len(example_content_lines) < 5:
            return (
                False,
                f"Example section has only {len(example_content_lines)} content lines (minimum: 5). "
                "Show actual artifact content, not just names.",
            )

    return True, None


def validate_file_references(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    for resource_field in ("references", "scripts", "invariants"):
        entries = frontmatter.get(resource_field)
        if entries is None or not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, str):
                continue
            if entry.startswith("skills/"):
                root = find_skill_root(skill_dir)
                ref_path = root.parent / entry if root is not None else skill_dir / entry
            else:
                ref_path = skill_dir / entry
            if not ref_path.exists() and not overlay:
                return (
                    False,
                    f"Declared {resource_field[:-1]} not found: {entry} (expected at {ref_path})",
                )
    return True, None


def validate_skill(skill_path: str | Path) -> tuple[bool, str]:
    """Validate a SkillCard."""
    skill_dir = Path(skill_path)
    if is_project_guidance_file(skill_dir):
        return validate_project_guidance(skill_dir)
    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text(encoding="utf8")
    if not content.startswith("---"):
        return False, "No YAML frontmatter found"

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    try:
        frontmatter = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return False, f"Invalid YAML in frontmatter: {exc}"
    if not isinstance(frontmatter, dict):
        return False, "Frontmatter must be a YAML dictionary"

    removed_keys = set(frontmatter.keys()) & REMOVED_AUTHORITY_FIELDS
    if removed_keys:
        return False, (
            "Removed authority field(s) in SKILL.md frontmatter: "
            + ", ".join(sorted(removed_keys))
            + ". Move external action authority to capability manifests."
        )
    unexpected_keys = set(frontmatter.keys()) - SKILL_CARD_FIELDS
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed SkillCard properties are: {', '.join(sorted(SKILL_CARD_FIELDS))}"
        )

    name = frontmatter.get("name", skill_dir.name)
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.fullmatch(r"[a-z0-9-]+", name):
            return False, f"Name '{name}' should be kebab-case"
        if name.startswith("-") or name.endswith("-") or "--" in name:
            return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        if len(name) > 64:
            return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        if "<" in description or ">" in description:
            return False, "Description cannot contain angle brackets (< or >)"
        if len(description) > 1024:
            return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    for key in sorted(STRING_ARRAY_FIELDS):
        ok, message = validate_string_array(frontmatter, key)
        if not ok:
            return False, message or f"Invalid '{key}' field"

    ok, message = validate_selection(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'selection' field"

    ok, message = validate_file_references(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid file references"

    ok, message = validate_v3_doctrine(frontmatter, content, skill_dir)
    if not ok:
        return False, message or "v3 doctrine violation"

    return True, "SkillCard is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
