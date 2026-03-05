#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import sys
import os
import re
import yaml
from pathlib import Path

def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    # Check SKILL.md exists
    skill_md = skill_path / 'SKILL.md'
    if not skill_md.exists():
        return False, "SKILL.md not found"

    # Read and validate frontmatter
    content = skill_md.read_text()
    if not content.startswith('---'):
        return False, "No YAML frontmatter found"

    # Extract frontmatter
    match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    # Parse YAML frontmatter
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
        if not isinstance(frontmatter, dict):
            return False, "Frontmatter must be a YAML dictionary"
    except yaml.YAMLError as e:
        return False, f"Invalid YAML in frontmatter: {e}"

    # Define allowed properties
    # Core fields parsed by contract.ts normalizeContract():
    #   name, description, tools, budget, outputs,
    #   consumes, composable_with,
    #   max_parallel, stability, cost_hint
    # Additional metadata fields:
    #   license, allowed-tools, metadata, compatibility
    ALLOWED_PROPERTIES = {
        'name', 'description',
        'tools', 'budget', 'outputs', 'consumes',
        'composable_with',
        'max_parallel', 'stability', 'cost_hint',
        'license', 'allowed-tools', 'metadata', 'compatibility',
    }

    # Check for unexpected properties (excluding nested keys under metadata)
    unexpected_keys = set(frontmatter.keys()) - ALLOWED_PROPERTIES
    if unexpected_keys:
        return False, (
            f"Unexpected key(s) in SKILL.md frontmatter: {', '.join(sorted(unexpected_keys))}. "
            f"Allowed properties are: {', '.join(sorted(ALLOWED_PROPERTIES))}"
        )

    # Check required fields
    if 'name' not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if 'description' not in frontmatter:
        return False, "Missing 'description' in frontmatter"
    if 'tools' not in frontmatter:
        return False, "Missing 'tools' in frontmatter"
    if 'budget' not in frontmatter:
        return False, "Missing 'budget' in frontmatter"
    if 'outputs' not in frontmatter:
        return False, "Missing 'outputs' in frontmatter"
    if 'consumes' not in frontmatter:
        return False, "Missing 'consumes' in frontmatter"
    if 'tier' in frontmatter:
        return False, "Frontmatter field 'tier' is not allowed. Tier is derived from directory layout."

    # Extract name for validation
    name = frontmatter.get('name', '')
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if name:
        # Check naming convention (kebab-case: lowercase with hyphens)
        if not re.match(r'^[a-z0-9-]+$', name):
            return False, f"Name '{name}' should be kebab-case (lowercase letters, digits, and hyphens only)"
        if name.startswith('-') or name.endswith('-') or '--' in name:
            return False, f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens"
        # Check name length (max 64 characters per spec)
        if len(name) > 64:
            return False, f"Name is too long ({len(name)} characters). Maximum is 64 characters."

    # Extract and validate description
    description = frontmatter.get('description', '')
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if description:
        # Check for angle brackets
        if '<' in description or '>' in description:
            return False, "Description cannot contain angle brackets (< or >)"
        # Check description length (max 1024 characters per spec)
        if len(description) > 1024:
            return False, f"Description is too long ({len(description)} characters). Maximum is 1024 characters."

    tools = frontmatter.get('tools')
    if not isinstance(tools, dict):
        return False, "Field 'tools' must be an object"
    for key in ('required', 'optional', 'denied'):
        if key not in tools:
            return False, f"Missing 'tools.{key}' in frontmatter"
        value = tools.get(key)
        if not isinstance(value, list):
            return False, f"Field 'tools.{key}' must be an array"
        for i, item in enumerate(value):
            if not isinstance(item, str):
                return False, f"Field 'tools.{key}[{i}]' must be a string"
            if not item.strip():
                return False, f"Field 'tools.{key}[{i}]' cannot be empty"

    budget = frontmatter.get('budget')
    if not isinstance(budget, dict):
        return False, "Field 'budget' must be an object"
    max_tool_calls = budget.get('max_tool_calls')
    if not isinstance(max_tool_calls, (int, float)):
        return False, "Missing numeric field 'budget.max_tool_calls'"
    if int(max_tool_calls) < 1:
        return False, "Field 'budget.max_tool_calls' must be >= 1"

    max_tokens = budget.get('max_tokens')
    if not isinstance(max_tokens, (int, float)):
        return False, "Missing numeric field 'budget.max_tokens'"
    if int(max_tokens) < 1000:
        return False, "Field 'budget.max_tokens' must be >= 1000"

    for key in ('outputs', 'consumes'):
        value = frontmatter.get(key)
        if not isinstance(value, list):
            return False, f"Field '{key}' must be an array"
        for i, item in enumerate(value):
            if not isinstance(item, str):
                return False, f"Field '{key}[{i}]' must be a string"
            if not item.strip():
                return False, f"Field '{key}[{i}]' cannot be empty"

    # Validate compatibility field if present (optional)
    compatibility = frontmatter.get('compatibility', '')
    if compatibility:
        if not isinstance(compatibility, str):
            return False, f"Compatibility must be a string, got {type(compatibility).__name__}"
        if len(compatibility) > 500:
            return False, f"Compatibility is too long ({len(compatibility)} characters). Maximum is 500 characters."

    return True, "Skill is valid!"

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)
    
    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
