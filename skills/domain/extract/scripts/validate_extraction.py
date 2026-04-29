#!/usr/bin/env python3
"""Validate an extracted payload against a field schema.

Input (JSON on stdin):
  {
    "schema": {
      "required_fields": [str],
      "optional_fields": [str],
      "field_types": {"field_name": "string" | "number" | "array" | "object" | "boolean"}
    },
    "payload": object
  }

Output (JSON on stdout):
  {
    "valid": bool,
    "missing_required": [str],
    "type_errors": [{"field": str, "expected": str, "actual": str}],
    "null_fields": [str],
    "extra_fields": [str]
  }
"""

from __future__ import annotations

import json
import sys

TYPE_MAP = {
    "string": str,
    "number": (int, float),
    "array": list,
    "object": dict,
    "boolean": bool,
}


def validate(schema: dict, payload: dict) -> dict:
    required = set(schema.get("required_fields", []))
    optional = set(schema.get("optional_fields", []))
    field_types = schema.get("field_types", {})
    known = required | optional

    missing_required = []
    type_errors = []
    null_fields = []
    extra_fields = []

    for field in required:
        if field not in payload:
            missing_required.append(field)
        elif payload[field] is None:
            null_fields.append(field)

    for field, value in payload.items():
        if field not in known and known:
            extra_fields.append(field)

        if value is None:
            if field not in null_fields and field in required:
                null_fields.append(field)
            continue

        if field in field_types:
            expected_type_name = field_types[field]
            expected_type = TYPE_MAP.get(expected_type_name)
            if expected_type and not isinstance(value, expected_type):
                type_errors.append({
                    "field": field,
                    "expected": expected_type_name,
                    "actual": type(value).__name__,
                })

    return {
        "valid": len(missing_required) == 0 and len(type_errors) == 0,
        "missing_required": missing_required,
        "type_errors": type_errors,
        "null_fields": null_fields,
        "extra_fields": extra_fields,
    }


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        json.dump({"error": f"Invalid JSON: {exc}"}, sys.stdout)
        sys.exit(1)

    schema = data.get("schema", {})
    payload = data.get("payload", {})

    if not isinstance(payload, dict):
        json.dump({"error": "payload must be a JSON object"}, sys.stdout)
        sys.exit(1)

    json.dump(validate(schema, payload), sys.stdout)


if __name__ == "__main__":
    main()
