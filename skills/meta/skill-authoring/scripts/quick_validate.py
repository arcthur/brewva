#!/usr/bin/env python3
"""Minimal validator for latest-generation Brewva skills."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml


ALLOWED_PROPERTIES = {
    "name",
    "description",
    "routing",
    "selection",
    "intent",
    "effects",
    "resources",
    "execution_hints",
    "consumes",
    "requires",
    "composable_with",
    "stability",
    "references",
    "scripts",
    "heuristics",
    "invariants",
    "license",
    "compatibility",
    "source_name",
    "source_category",
    "forked_from",
    "forked_at",
    "tool",
}

STRING_ARRAY_FIELDS = {
    "consumes",
    "requires",
    "composable_with",
    "references",
    "scripts",
    "heuristics",
    "invariants",
}

EFFECT_CLASSES = {
    "workspace_read",
    "workspace_write",
    "local_exec",
    "runtime_observe",
    "external_network",
    "external_side_effect",
    "schedule_mutation",
    "memory_write",
}
COST_HINTS = {"low", "medium", "high"}
VERIFICATION_LEVELS = {"quick", "standard", "strict"}
SEMANTIC_ARTIFACT_SCHEMA_IDS = {
    "planning.design_spec.v1",
    "planning.execution_plan.v1",
    "planning.execution_mode_hint.v1",
    "planning.risk_register.v1",
    "planning.implementation_targets.v1",
    "implementation.change_set.v1",
    "implementation.files_changed.v1",
    "implementation.verification_evidence.v1",
    "review.review_report.v1",
    "review.review_findings.v1",
    "review.merge_decision.v1",
    "qa.qa_report.v1",
    "qa.qa_findings.v1",
    "qa.qa_verdict.v1",
    "qa.qa_checks.v1",
    "qa.qa_missing_evidence.v1",
    "qa.qa_confidence_gaps.v1",
    "qa.qa_environment_limits.v1",
    "ship.ship_report.v1",
    "ship.release_checklist.v1",
    "ship.ship_decision.v1",
}
OUTPUT_CONTRACT_KINDS = {"text", "enum", "json"}
TASK_PHASES = {
    "align",
    "investigate",
    "execute",
    "verify",
    "ready_for_acceptance",
    "blocked",
    "done",
}


def is_overlay_skill(skill_dir: Path) -> bool:
    parts = skill_dir.resolve().parts
    return len(parts) >= 3 and parts[-3:-1] == ("project", "overlays")


def derive_routing_scope(skill_dir: Path) -> str | None:
    parts = skill_dir.resolve().parts
    for scope in ("core", "domain", "operator", "meta"):
        if scope in parts:
            return scope
    return None


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


def validate_effect_array(
    effects: dict[str, object], key: str
) -> tuple[bool, str | None]:
    value = effects.get(key)
    if value is None:
        return True, None
    ok, message = validate_string_array_value(value, f"effects.{key}")
    if not ok:
        return ok, message
    for effect in value:
        if effect not in EFFECT_CLASSES:
            return (
                False,
                f"Field 'effects.{key}' contains unsupported effect '{effect}'",
            )
    return True, None


def validate_budget_object(
    value: object, label: str
) -> tuple[bool, str | None]:
    if not isinstance(value, dict):
        return False, f"Field '{label}' must be an object"

    recognized = 0
    for key, minimum in (
        ("max_tool_calls", 1),
        ("max_tokens", 1000),
        ("max_parallel", 1),
    ):
        if key not in value:
            continue
        recognized += 1
        ok, message = validate_positive_number(value[key], f"{label}.{key}", minimum)
        if not ok:
            return ok, message

    if recognized == 0:
        return (
            False,
            f"Field '{label}' must declare at least one of: max_tool_calls, max_tokens, max_parallel",
        )
    return True, None


def validate_output_contract_shape(
    contract: dict[str, object], label: str
) -> tuple[bool, str | None]:
    kind = contract.get("kind")
    if kind not in OUTPUT_CONTRACT_KINDS:
        return (
            False,
            f"Field '{label}.kind' must be one of: text | enum | json",
        )

    if kind == "text":
        for key in ("min_words", "min_length"):
            if key in contract:
                ok, message = validate_positive_number(contract[key], f"{label}.{key}", 1)
                if not ok:
                    return ok, message
    elif kind == "enum":
        values = contract.get("values")
        ok, message = validate_string_array_value(values, f"{label}.values")
        if not ok:
            return ok, message
        if "case_sensitive" in contract and not isinstance(contract["case_sensitive"], bool):
            return (
                False,
                f"Field '{label}.case_sensitive' must be a boolean",
            )
    elif kind == "json":
        for key in ("min_keys", "min_items"):
            if key in contract:
                ok, message = validate_positive_number(contract[key], f"{label}.{key}", 1)
                if not ok:
                    return ok, message
        if "required_fields" in contract:
            ok, message = validate_string_array_value(
                contract["required_fields"], f"{label}.required_fields"
            )
            if not ok:
                return ok, message
        item_contract = contract.get("item_contract")
        if item_contract is not None:
            if not isinstance(item_contract, dict):
                return False, f"Field '{label}.item_contract' must be an object"
            return validate_output_contract_shape(item_contract, f"{label}.item_contract")

    return True, None


def validate_output_contracts(
    intent: dict[str, object],
    skill_dir: Path,
    semantic_bound_outputs: set[str],
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    outputs = intent.get("outputs")

    if outputs is None:
        if overlay:
            return True, None
        return False, "Missing 'intent.outputs' in frontmatter"

    ok, message = validate_string_array_value(outputs, "intent.outputs")
    if not ok:
        return ok, message

    output_contracts = intent.get("output_contracts")
    if output_contracts is None:
        if outputs and not overlay:
            missing_authored = [
                output for output in outputs if isinstance(output, str) and output not in semantic_bound_outputs
            ]
            if not missing_authored:
                return True, None
            return False, "Missing 'intent.output_contracts' for declared outputs"
        return True, None

    if not isinstance(output_contracts, dict):
        return False, "Field 'intent.output_contracts' must be an object"

    declared_outputs = {item for item in outputs if isinstance(item, str)}
    contract_keys = set(output_contracts.keys())
    redundant_semantic = sorted(name for name in contract_keys if name in semantic_bound_outputs)
    if redundant_semantic and not overlay:
        return (
            False,
            "Field 'intent.output_contracts' must not declare semantic-bound outputs: "
            + ", ".join(redundant_semantic),
        )
    if not overlay:
        missing = sorted(
            name
            for name in declared_outputs - contract_keys
            if name not in semantic_bound_outputs
        )
        if missing:
            return (
                False,
                "Field 'intent.output_contracts' is missing contracts for: "
                + ", ".join(missing),
            )
    unexpected = sorted(
        name for name in contract_keys if declared_outputs and name not in declared_outputs
    )
    if unexpected and not overlay:
        return (
            False,
            "Field 'intent.output_contracts' contains undeclared outputs: "
            + ", ".join(unexpected),
        )

    for name, contract in output_contracts.items():
        if not isinstance(name, str) or not name.strip():
            return False, "Field 'intent.output_contracts' must use non-empty string keys"
        if not isinstance(contract, dict):
            return False, f"Field 'intent.output_contracts.{name}' must be an object"
        ok, message = validate_output_contract_shape(
            contract, f"intent.output_contracts.{name}"
        )
        if not ok:
            return ok, message

    return True, None


def validate_semantic_bindings(
    intent: dict[str, object]
) -> tuple[bool, str | None]:
    semantic_bindings = intent.get("semantic_bindings")
    if semantic_bindings is None:
        return True, None
    if not isinstance(semantic_bindings, dict):
        return False, "Field 'intent.semantic_bindings' must be an object"

    outputs = intent.get("outputs")
    declared_outputs = {item for item in outputs if isinstance(item, str)} if isinstance(outputs, list) else set()
    for name, schema_id in semantic_bindings.items():
        if not isinstance(name, str) or not name.strip():
            return False, "Field 'intent.semantic_bindings' must use non-empty string keys"
        if declared_outputs and name not in declared_outputs:
            return (
                False,
                "Field 'intent.semantic_bindings' contains undeclared outputs: " + name,
            )
        if not isinstance(schema_id, str) or schema_id not in SEMANTIC_ARTIFACT_SCHEMA_IDS:
            return (
                False,
                f"Field 'intent.semantic_bindings.{name}' must reference a known semantic artifact schema id",
            )
    return True, None


def validate_intent(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    intent = frontmatter.get("intent")
    if intent is None:
        if overlay:
            return True, None
        return False, "Missing 'intent' in frontmatter"
    if not isinstance(intent, dict):
        return False, "Field 'intent' must be an object"

    ok, message = validate_semantic_bindings(intent)
    if not ok:
        return ok, message

    semantic_bindings = intent.get("semantic_bindings")
    semantic_bound_outputs = (
        {
            name
            for name in semantic_bindings.keys()
            if isinstance(semantic_bindings, dict) and isinstance(name, str)
        }
        if isinstance(semantic_bindings, dict)
        else set()
    )

    ok, message = validate_output_contracts(intent, skill_dir, semantic_bound_outputs)
    if not ok:
        return ok, message

    completion_definition = intent.get("completion_definition")
    if completion_definition is not None:
        if not isinstance(completion_definition, dict):
            return False, "Field 'intent.completion_definition' must be an object"
        verification_level = completion_definition.get("verification_level")
        if (
            verification_level is not None
            and verification_level not in VERIFICATION_LEVELS
        ):
            return (
                False,
                "Field 'intent.completion_definition.verification_level' must be one of: quick | standard | strict",
            )
        ok, message = validate_string_array(
            completion_definition, "required_evidence_kinds"
        )
        if not ok:
            return False, message.replace(
                "Field 'required_evidence_kinds'",
                "Field 'intent.completion_definition.required_evidence_kinds'",
            )

    return True, None


def validate_effects(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    effects = frontmatter.get("effects")
    if effects is None:
        if overlay:
            return True, None
        return False, "Missing 'effects' in frontmatter"
    if not isinstance(effects, dict):
        return False, "Field 'effects' must be an object"

    if "effect_level" in effects:
        return False, "Field 'effects.effect_level' has been removed; declare 'effects.allowed_effects' instead"
    if "rollback_required" in effects:
        return False, "Field 'effects.rollback_required' has been removed from the stable contract surface"
    if "approval_required" in effects:
        return False, "Field 'effects.approval_required' has been removed from the stable contract surface"

    if "allowed_effects" not in effects and not overlay:
        return False, "Missing 'effects.allowed_effects' in frontmatter"

    for key in ("allowed_effects", "denied_effects"):
        ok, message = validate_effect_array(effects, key)
        if not ok:
            return ok, message

    return True, None


def validate_resources(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    resources = frontmatter.get("resources")
    if resources is None:
        if overlay:
            return True, None
        return False, "Missing 'resources' in frontmatter"
    if not isinstance(resources, dict):
        return False, "Field 'resources' must be an object"

    default_lease = resources.get("default_lease")
    if default_lease is None:
        if not overlay:
            return False, "Missing 'resources.default_lease' in frontmatter"
    else:
        ok, message = validate_budget_object(default_lease, "resources.default_lease")
        if not ok:
            return ok, message

    hard_ceiling = resources.get("hard_ceiling")
    if hard_ceiling is None:
        if not overlay:
            return False, "Missing 'resources.hard_ceiling' in frontmatter"
    else:
        ok, message = validate_budget_object(hard_ceiling, "resources.hard_ceiling")
        if not ok:
            return ok, message

    if isinstance(default_lease, dict) and isinstance(hard_ceiling, dict):
        for key in ("max_tool_calls", "max_tokens", "max_parallel"):
            default_value = default_lease.get(key)
            hard_value = hard_ceiling.get(key)
            if isinstance(default_value, int) and isinstance(hard_value, int):
                if hard_value < default_value:
                    return (
                        False,
                        f"Field 'resources.hard_ceiling.{key}' must be >= 'resources.default_lease.{key}'",
                    )

    return True, None


def validate_execution_hints(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    hints = frontmatter.get("execution_hints")
    if hints is None:
        if overlay:
            return True, None
        return False, "Missing 'execution_hints' in frontmatter"
    if not isinstance(hints, dict):
        return False, "Field 'execution_hints' must be an object"

    for key in ("preferred_tools", "fallback_tools"):
        value = hints.get(key)
        if value is None:
            if not overlay:
                return False, f"Missing 'execution_hints.{key}' in frontmatter"
            continue
        ok, message = validate_string_array_value(value, f"execution_hints.{key}")
        if not ok:
            return ok, message

    cost_hint = hints.get("cost_hint")
    if cost_hint is not None and cost_hint not in COST_HINTS:
        return False, "Field 'execution_hints.cost_hint' must be one of: low | medium | high"

    suggested_chains = hints.get("suggested_chains")
    if suggested_chains is not None:
        if not isinstance(suggested_chains, list):
            return False, "Field 'execution_hints.suggested_chains' must be an array"
        for index, entry in enumerate(suggested_chains):
            if not isinstance(entry, dict):
                return (
                    False,
                    f"Field 'execution_hints.suggested_chains[{index}]' must be an object",
                )
            ok, message = validate_string_array(entry, "steps")
            if not ok:
                return False, message.replace(
                    "Field 'steps'",
                    f"Field 'execution_hints.suggested_chains[{index}].steps'",
                )

    return True, None


def validate_selection(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    routed_scope = derive_routing_scope(skill_dir)
    selection = frontmatter.get("selection")

    if routed_scope is None and not overlay:
        if selection is not None:
            return False, "Field 'selection' is only supported for routed skills and overlays"
        return True, None

    if selection is None:
        if overlay:
            return True, None
        return False, "Missing 'selection' in frontmatter"

    if not isinstance(selection, dict):
        return False, "Field 'selection' must be an object"

    if "whenToUse" in selection:
        return False, "Field 'selection.whenToUse' has been removed; use 'selection.when_to_use'"

    allowed_keys = {"when_to_use", "examples", "paths", "phases"}
    unexpected_keys = set(selection.keys()) - allowed_keys
    if unexpected_keys:
        return False, (
            "Unexpected key(s) in 'selection': "
            + ", ".join(sorted(unexpected_keys))
        )

    when_to_use = selection.get("when_to_use")
    if when_to_use is not None:
        if not isinstance(when_to_use, str) or not when_to_use.strip():
            return False, "Field 'selection.when_to_use' must be a non-empty string"
    elif not overlay:
        return False, "Missing 'selection.when_to_use' in frontmatter"

    for key in ("examples", "paths", "phases"):
        if key not in selection:
            continue
        ok, message = validate_string_array_value(selection[key], f"selection.{key}")
        if not ok:
            return ok, message

    for phase in selection.get("phases", []) if isinstance(selection.get("phases"), list) else []:
        if phase not in TASK_PHASES:
            return (
                False,
                "Field 'selection.phases' contains unsupported phase '"
                + str(phase)
                + "'",
            )

    if (
        when_to_use is None
        and not selection.get("examples")
        and not selection.get("paths")
        and not selection.get("phases")
    ):
        return False, (
            "Field 'selection' must declare at least one of: when_to_use, examples, paths, phases"
        )

    return True, None


def validate_routing(
    frontmatter: dict[str, object], skill_dir: Path
) -> tuple[bool, str | None]:
    overlay = is_overlay_skill(skill_dir)
    routed_scope = derive_routing_scope(skill_dir)
    routing = frontmatter.get("routing")

    if routing is None:
        return True, None
    if not isinstance(routing, dict):
        return False, "Field 'routing' must be an object"
    if overlay or routed_scope is None:
        return False, "Field 'routing' is only supported for routed non-overlay skills"

    if "matchHints" in routing:
        return False, "Field 'routing.matchHints' has been removed"
    if "match_hints" in routing:
        return False, "Field 'routing.match_hints' has been removed"
    if "continuityRequired" in routing or "continuity_required" in routing:
        return False, "Continuity routing metadata has been removed"

    unexpected_keys = set(routing.keys()) - {"scope"}
    if unexpected_keys:
        return False, (
            "Unexpected key(s) in 'routing': " + ", ".join(sorted(unexpected_keys))
        )
    if "scope" in routing and routing["scope"] != routed_scope:
        return False, f"Field 'routing.scope' must match directory-derived scope '{routed_scope}'"

    return True, None


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

V2_REQUIRED_SECTIONS_CORE_DOMAIN = [
    "## The Iron Law",
    "## Red Flags",
]

V2_REQUIRED_SECTIONS_ALL = [
    "## When to Use",
    "## Workflow",
    "## Stop Conditions",
]

V2_BODY_LINE_LIMIT = 180


def validate_v2_doctrine(
    frontmatter: dict[str, object],
    content: str,
    skill_dir: Path,
) -> tuple[bool, str | None]:
    """Validate v2 anatomy doctrine: section structure, description hygiene, body size."""
    overlay = is_overlay_skill(skill_dir)
    if overlay:
        return True, None

    routed_scope = derive_routing_scope(skill_dir)

    description = frontmatter.get("description", "")
    if isinstance(description, str):
        for pattern in WORKFLOW_LEAK_PATTERNS:
            if pattern.search(description):
                return (
                    False,
                    f"Description leaks workflow methodology (matched: {pattern.pattern}). "
                    "Description must contain trigger conditions only, never workflow summary.",
                )

    match = re.match(r"^---\n.*?\n---\n(.*)", content, re.DOTALL)
    if not match:
        return True, None
    body = match.group(1)

    body_lines = [line for line in body.split("\n") if line.strip()]
    if len(body_lines) > V2_BODY_LINE_LIMIT:
        return (
            False,
            f"SKILL.md body has {len(body_lines)} non-empty lines (limit: {V2_BODY_LINE_LIMIT}). "
            "Move heavy content to references/.",
        )

    for section in V2_REQUIRED_SECTIONS_ALL:
        if section not in body:
            alt = section.replace("## When to Use", "## Trigger")
            if alt not in body and section not in body:
                return (
                    False,
                    f"Missing required v2 section: '{section}' (or equivalent)",
                )

    if routed_scope in ("core", "domain"):
        for section in V2_REQUIRED_SECTIONS_CORE_DOMAIN:
            if section not in body:
                return (
                    False,
                    f"Missing required v2 section for {routed_scope} skill: '{section}'",
                )

    if routed_scope in ("core", "domain"):
        phase_headers = re.findall(r"^###\s+Phase\s+\d+", body, re.MULTILINE)
        if len(phase_headers) >= 2:
            failure_indicators = [
                "**If ", "**If not", "**If any", "**If the",
                "If not reproducible", "If any check fails",
                "If validation fails", "If reproducible",
            ]
            has_failure_branch = any(ind in body for ind in failure_indicators)
            if not has_failure_branch:
                return (
                    False,
                    "Workflow has multiple phases but no explicit failure branches. "
                    "Each phase transition must say what happens on failure.",
                )

    example_match = re.search(r"^## (?:Concrete )?Example\b.*?\n(.*?)(?=^## |\Z)", body, re.DOTALL | re.MULTILINE)
    if example_match:
        example_body = example_match.group(1).strip()
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

    scripts = frontmatter.get("scripts")
    if scripts is not None and isinstance(scripts, list):
        for entry in scripts:
            if not isinstance(entry, str):
                continue
            script_path = skill_dir / entry
            if not script_path.exists():
                return (
                    False,
                    f"Declared script not found: {entry} (expected at {script_path})",
                )

    references = frontmatter.get("references")
    if references is not None and isinstance(references, list):
        for entry in references:
            if not isinstance(entry, str):
                continue
            if entry.startswith("skills/"):
                repo_root = skill_dir
                while repo_root.name != "skills" and repo_root != repo_root.parent:
                    repo_root = repo_root.parent
                if repo_root.name == "skills":
                    repo_root = repo_root.parent
                ref_path = repo_root / entry
            else:
                ref_path = skill_dir / entry
            if not ref_path.exists():
                if not overlay:
                    return (
                        False,
                        f"Declared reference not found: {entry} (expected at {ref_path})",
                    )

    return True, None


def validate_skill(skill_path: str | Path) -> tuple[bool, str]:
    """Basic validation of a latest-generation skill directory."""
    skill_dir = Path(skill_path)
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

    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    if "tier" in frontmatter:
        return False, "Frontmatter field 'tier' is not allowed. Category is directory-derived."
    if "category" in frontmatter:
        return False, "Frontmatter field 'category' is not allowed. Category is directory-derived."

    overlay = is_overlay_skill(skill_dir)
    if not overlay and "consumes" not in frontmatter:
        return False, "Missing 'consumes' in frontmatter"

    name = frontmatter.get("name", skill_dir.name)
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        if not re.fullmatch(r"[a-z0-9-]+", name):
            return False, f"Name '{name}' should be kebab-case (lowercase letters, digits, and hyphens only)"
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

    ok, message = validate_intent(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'intent' field"

    ok, message = validate_effects(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'effects' field"

    ok, message = validate_resources(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'resources' field"

    ok, message = validate_execution_hints(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'execution_hints' field"

    if "dispatch" in frontmatter:
        return False, "Field 'dispatch' has been removed"

    ok, message = validate_selection(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'selection' field"

    ok, message = validate_routing(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid 'routing' field"

    compatibility = frontmatter.get("compatibility", "")
    if compatibility and (not isinstance(compatibility, str) or len(compatibility) > 500):
        return False, "Field 'compatibility' must be a string shorter than 500 characters"

    ok, message = validate_file_references(frontmatter, skill_dir)
    if not ok:
        return False, message or "Invalid file references"

    ok, message = validate_v2_doctrine(frontmatter, content, skill_dir)
    if not ok:
        return False, message or "v2 doctrine violation"

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
