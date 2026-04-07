import type { ShapeCheck, ShapeGrade } from "../types.ts";

interface OutputContract {
  kind: "text" | "enum" | "json";
  min_words?: number;
  min_length?: number;
  min_keys?: number;
  min_items?: number;
  values?: string[];
  required_fields?: string[];
}

export function gradeShape(
  outputs: Record<string, unknown>,
  contracts: Record<string, OutputContract>,
): ShapeGrade {
  const checks: ShapeCheck[] = [];

  for (const [name, contract] of Object.entries(contracts)) {
    const value = outputs[name];

    if (value === undefined || value === null) {
      checks.push({
        output_name: name,
        rule: "present",
        pass: false,
        detail: "Output missing",
      });
      continue;
    }

    checks.push({
      output_name: name,
      rule: "present",
      pass: true,
    });

    if (contract.kind === "text") {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      if (contract.min_length !== undefined) {
        checks.push({
          output_name: name,
          rule: `min_length >= ${contract.min_length}`,
          pass: text.length >= contract.min_length,
          detail: `length=${text.length}`,
        });
      }
      if (contract.min_words !== undefined) {
        const wordCount = text.trim().split(/\s+/).length;
        checks.push({
          output_name: name,
          rule: `min_words >= ${contract.min_words}`,
          pass: wordCount >= contract.min_words,
          detail: `words=${wordCount}`,
        });
      }
    }

    if (contract.kind === "enum") {
      const str = typeof value === "string" ? value : JSON.stringify(value);
      const allowed = contract.values ?? [];
      checks.push({
        output_name: name,
        rule: `enum in [${allowed.join(", ")}]`,
        pass: allowed.includes(str),
        detail: `value="${str}"`,
      });
    }

    if (contract.kind === "json") {
      if (typeof value !== "object") {
        checks.push({
          output_name: name,
          rule: "is_object_or_array",
          pass: false,
          detail: `type=${typeof value}`,
        });
        continue;
      }

      if (contract.min_keys !== undefined && !Array.isArray(value)) {
        const keyCount = Object.keys(value as Record<string, unknown>).length;
        checks.push({
          output_name: name,
          rule: `min_keys >= ${contract.min_keys}`,
          pass: keyCount >= contract.min_keys,
          detail: `keys=${keyCount}`,
        });
      }

      if (contract.min_items !== undefined && Array.isArray(value)) {
        checks.push({
          output_name: name,
          rule: `min_items >= ${contract.min_items}`,
          pass: value.length >= contract.min_items,
          detail: `items=${value.length}`,
        });
      }

      if (contract.required_fields !== undefined && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        for (const field of contract.required_fields) {
          checks.push({
            output_name: name,
            rule: `has_field "${field}"`,
            pass: field in obj,
          });
        }
      }
    }
  }

  return {
    pass: checks.every((c) => c.pass),
    checks,
  };
}
