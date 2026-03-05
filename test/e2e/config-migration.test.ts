import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupWorkspace, createWorkspace, runCliSync } from "./helpers.js";

function writeRemovedTelegramConfig(workspace: string): void {
  const configDir = join(workspace, ".brewva");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "brewva.json"),
    JSON.stringify(
      {
        channels: {
          telegram: {
            skillPolicy: {
              behaviorSkillName: "telegram-behavior-v2",
              interactiveSkillName: "telegram-ui-v2",
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("e2e: config migration", () => {
  test("fails fast when removed channels.telegram branch is present", () => {
    const workspace = createWorkspace("config-migration");
    writeRemovedTelegramConfig(workspace);

    try {
      const run = runCliSync(workspace, ["--print", "health check prompt"]);
      expect(run.error).toBeUndefined();
      expect(run.status).toBe(1);

      const stderr = run.stderr ?? "";
      expect(stderr).toContain("[config:error]");
      expect(stderr).toContain('unknown property "telegram"');
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
