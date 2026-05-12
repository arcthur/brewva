export function formatSkillValidationError(input: {
  skillName: string;
  missing: readonly string[];
  invalid: ReadonlyArray<{ name: string; reason: string }>;
}): string {
  const parts: string[] = [];
  if (input.missing.length > 0) {
    parts.push(`missing=${input.missing.join(",")}`);
  }
  if (input.invalid.length > 0) {
    parts.push(
      `invalid=${input.invalid.map((entry) => `${entry.name}:${entry.reason}`).join(",")}`,
    );
  }
  return `subagent_skill_outputs_invalid:${input.skillName}${parts.length > 0 ? `:${parts.join(";")}` : ""}`;
}
