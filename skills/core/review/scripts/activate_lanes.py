#!/usr/bin/env python3
"""Deterministic review lane activation based on change classifiers.

Input (JSON on stdin):
  {
    "change_categories": [str],
    "changed_file_classes": [str],
    "has_impact_map": bool,
    "has_design_spec": bool,
    "has_risk_register": bool
  }

Output (JSON on stdout):
  {
    "always_on": [str],
    "conditional": [str],
    "activation_basis": str,
    "widened": bool
  }
"""

from __future__ import annotations

import json
import sys

ALWAYS_ON = ["review-correctness", "review-boundaries", "review-operability"]

CATEGORY_TO_LANE = {
    "authn": "review-security",
    "authz": "review-security",
    "credential_handling": "review-security",
    "secret_io": "review-security",
    "external_input": "review-security",
    "network_boundary": "review-security",
    "permission_policy": "review-security",
    "wal_replay": "review-concurrency",
    "rollback": "review-concurrency",
    "scheduler": "review-concurrency",
    "queueing": "review-concurrency",
    "async_ordering": "review-concurrency",
    "cross_session_state": "review-concurrency",
    "multi_writer_state": "review-concurrency",
    "cli_surface": "review-compatibility",
    "config_schema": "review-compatibility",
    "public_api": "review-compatibility",
    "export_map": "review-compatibility",
    "persisted_format": "review-compatibility",
    "wire_protocol": "review-compatibility",
    "package_boundary": "review-compatibility",
    "hot_path": "review-performance",
    "indexing_scan": "review-performance",
    "fanout_parallelism": "review-performance",
    "queue_growth": "review-performance",
    "artifact_volume": "review-performance",
    "storage_churn": "review-performance",
}

FILE_CLASS_TO_LANE = {
    "auth_surface": "review-security",
    "credential_surface": "review-security",
    "network_boundary": "review-security",
    "permission_surface": "review-security",
    "wal_replay": "review-concurrency",
    "rollback_surface": "review-concurrency",
    "scheduler": "review-concurrency",
    "runtime_coordination": "review-concurrency",
    "queueing_parallelism": "review-concurrency",
    "cli_surface": "review-compatibility",
    "config_surface": "review-compatibility",
    "public_api": "review-compatibility",
    "persisted_format": "review-compatibility",
    "package_boundary": "review-compatibility",
    "artifact_scan": "review-performance",
    "storage_churn": "review-performance",
}

NEUTRAL_FILE_CLASSES = {"docs_only", "tests_only", "fixtures_only"}
WIDENING_FILE_CLASS = "mixed_unknown"

ALL_CONDITIONAL = ["review-security", "review-concurrency", "review-compatibility", "review-performance"]


def activate(data: dict) -> dict:
    categories = data.get("change_categories", [])
    file_classes = data.get("changed_file_classes", [])
    has_impact = data.get("has_impact_map", False)
    has_design = data.get("has_design_spec", False)
    has_risk = data.get("has_risk_register", False)

    conditional: set[str] = set()
    basis_parts: list[str] = []
    widened = False

    for cat in categories:
        if cat in CATEGORY_TO_LANE:
            lane = CATEGORY_TO_LANE[cat]
            conditional.add(lane)
            basis_parts.append(f"category:{cat}->{lane}")

    for fc in file_classes:
        if fc in FILE_CLASS_TO_LANE:
            lane = FILE_CLASS_TO_LANE[fc]
            conditional.add(lane)
            basis_parts.append(f"file_class:{fc}->{lane}")

    if WIDENING_FILE_CLASS in file_classes:
        conditional = set(ALL_CONDITIONAL)
        widened = True
        basis_parts.append("file_class:mixed_unknown->full_conditional_set")

    non_neutral = [fc for fc in file_classes if fc not in NEUTRAL_FILE_CLASSES and fc != WIDENING_FILE_CLASS]
    if non_neutral and not conditional and not widened:
        conditional = set(ALL_CONDITIONAL)
        widened = True
        basis_parts.append("non_neutral_unclassified->full_conditional_set")

    evidence_weak = not has_impact or not has_design or not has_risk
    if evidence_weak and not widened and not conditional:
        conditional = set(ALL_CONDITIONAL)
        widened = True
        basis_parts.append("weak_evidence->full_conditional_set")

    return {
        "always_on": ALWAYS_ON,
        "conditional": sorted(conditional),
        "activation_basis": "; ".join(basis_parts) if basis_parts else "no conditional lanes activated",
        "widened": widened,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    json.dump(activate(data), sys.stdout)


if __name__ == "__main__":
    main()
