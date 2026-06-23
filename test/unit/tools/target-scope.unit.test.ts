import { describe, expect, test } from "bun:test";
import { describeTargetScopeRejection } from "@brewva/brewva-tools/runtime-port";

describe("describeTargetScopeRejection", () => {
  test("states the boundary and guides back inside the target root", () => {
    const message = describeTargetScopeRejection({
      tool: "glob",
      subject: "workdir",
      allowedRoots: ["/Users/me/project"],
    });

    expect(message).toContain("glob rejected: workdir escapes target roots (/Users/me/project).");
    expect(message).toContain("home directory");
    expect(message).toContain(".claude/worktrees");
  });

  test("joins multiple roots and surfaces the offending value", () => {
    const message = describeTargetScopeRejection({
      tool: "look_at",
      subject: "path",
      allowedRoots: ["/a", "/b"],
      offending: "/etc/passwd",
    });

    expect(message).toContain("escapes target roots (/a, /b).");
    expect(message).toContain("/etc/passwd");
  });
});
