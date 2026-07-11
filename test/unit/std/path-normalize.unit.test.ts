import { describe, expect, test } from "bun:test";
import { relativePosixPath } from "@brewva/brewva-std/node/fs";
import { toPosixPath } from "@brewva/brewva-std/text";

describe("std posix path normalization", () => {
  test("toPosixPath rewrites backslash separators to forward slash", () => {
    expect(toPosixPath("a\\b\\c")).toBe("a/b/c");
    expect(toPosixPath("already/posix")).toBe("already/posix");
    expect(toPosixPath("")).toBe("");
    expect(toPosixPath("mixed\\a/b\\c")).toBe("mixed/a/b/c");
  });

  test("toPosixPath composes with trim/strip decorations", () => {
    expect(toPosixPath("  a\\b  ".trim())).toBe("a/b");
    expect(toPosixPath(".\\a\\b").replace(/^\.\//u, "")).toBe("a/b");
  });

  test("relativePosixPath makes a path relative then normalizes separators", () => {
    expect(relativePosixPath("/root/base", "/root/base/child/file.ts")).toBe("child/file.ts");
    expect(relativePosixPath("/root/base", "/root/base")).toBe("");
    expect(relativePosixPath("/root/base", "/root/sibling")).toBe("../sibling");
  });
});
