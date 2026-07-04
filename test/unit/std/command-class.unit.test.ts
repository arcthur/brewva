import { describe, expect, test } from "bun:test";
import { classifyCommandClass } from "@brewva/brewva-std/command-class";

describe("classifyCommandClass", () => {
  test("recognizes plain build and test invocations", () => {
    expect(classifyCommandClass("make build")).toBe("verification");
    expect(classifyCommandClass("swift build -c release")).toBe("verification");
    expect(classifyCommandClass("cargo test --workspace")).toBe("verification");
    expect(classifyCommandClass("bun test test/unit")).toBe("verification");
    expect(classifyCommandClass("tsc -b")).toBe("verification");
    expect(classifyCommandClass("pytest -q")).toBe("verification");
  });

  test("requires the check-shaped subcommand where the head is ambiguous", () => {
    expect(classifyCommandClass("bun run start")).toBe("general");
    expect(classifyCommandClass("bun run typecheck")).toBe("verification");
    expect(classifyCommandClass("go run ./cmd/server")).toBe("general");
    expect(classifyCommandClass("go test ./...")).toBe("verification");
    expect(classifyCommandClass("python -m http.server")).toBe("general");
    expect(classifyCommandClass("python -m pytest tests/")).toBe("verification");
  });

  test("classifies compound commands by any verification segment", () => {
    expect(classifyCommandClass("make clean && make build")).toBe("verification");
    expect(classifyCommandClass("cd app && swift build")).toBe("verification");
    expect(classifyCommandClass("rm -rf dist && ls")).toBe("general");
  });

  test("skips env assignments and bare cd segments", () => {
    expect(classifyCommandClass("CI=1 bun test")).toBe("verification");
    expect(classifyCommandClass("cd /tmp")).toBe("general");
  });

  test("unknown commands stay general", () => {
    expect(classifyCommandClass("git status")).toBe("general");
    expect(classifyCommandClass("open Murmur.app")).toBe("general");
    expect(classifyCommandClass("")).toBe("general");
  });
});
