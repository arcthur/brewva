import { describe, expect, test } from "bun:test";
import { createInMemoryBoxPlane, fingerprintBoxScope, type BoxScope } from "@brewva/brewva-box";

function sessionScope(input: Partial<BoxScope> = {}): BoxScope {
  return {
    kind: "session",
    id: "session-alpha",
    image: "ghcr.io/brewva/box-default:latest",
    workspaceRoot: "/workspace/source",
    capabilities: {
      network: { mode: "off" },
      gpu: false,
      extraVolumes: [],
      secrets: [],
      ports: [],
    },
    ...input,
  };
}

describe("box plane scope semantics", () => {
  test("reuses the same box for an identical scope fingerprint", async () => {
    const plane = createInMemoryBoxPlane();
    const scope = sessionScope();

    const first = await plane.acquire(scope);
    const second = await plane.acquire(structuredClone(scope));

    expect(first.acquisitionReason).toBe("created");
    expect(second.acquisitionReason).toBe("reused");
    expect(second.id).toBe(first.id);
    expect(fingerprintBoxScope(second.scope)).toBe(fingerprintBoxScope(first.scope));
    expect(await plane.inspect()).toMatchObject({
      boxes: [
        {
          id: first.id,
          fingerprint: fingerprintBoxScope(scope),
          createReason: "created",
        },
      ],
    });
  });

  test("creates a new box when capabilities change in either direction", async () => {
    const plane = createInMemoryBoxPlane();
    const base = await plane.acquire(
      sessionScope({
        capabilities: {
          network: { mode: "allowlist", allow: ["registry.npmjs.org"] },
          gpu: false,
          extraVolumes: [],
          secrets: ["npm_token"],
          ports: [],
        },
      }),
    );

    const narrowed = await plane.acquire(
      sessionScope({
        capabilities: {
          network: { mode: "off" },
          gpu: false,
          extraVolumes: [],
          secrets: [],
          ports: [],
        },
      }),
    );
    const widened = await plane.acquire(
      sessionScope({
        capabilities: {
          network: { mode: "allowlist", allow: ["registry.npmjs.org", "github.com"] },
          gpu: false,
          extraVolumes: [],
          secrets: ["npm_token"],
          ports: [],
        },
      }),
    );

    expect(narrowed.id).not.toBe(base.id);
    expect(narrowed.acquisitionReason).toBe("capability_changed");
    expect(widened.acquisitionReason).toBe("capability_changed");
    expect(widened.id).not.toBe(base.id);
    expect((await plane.inspect()).boxes.map((box) => box.createReason)).toEqual([
      "created",
      "capability_changed",
      "capability_changed",
    ]);
  });

  test("serializes concurrent acquire calls for the same fingerprint", async () => {
    const plane = createInMemoryBoxPlane();
    const scope = sessionScope();

    const handles = await Promise.all(Array.from({ length: 16 }, () => plane.acquire(scope)));

    expect(new Set(handles.map((handle) => handle.id)).size).toBe(1);
    expect((await plane.inspect()).boxes).toHaveLength(1);
  });

  test("treats workspaceRoot as immutable for an acquired session scope", async () => {
    const plane = createInMemoryBoxPlane();
    const first = await plane.acquire(sessionScope({ workspaceRoot: "/workspace/source-a" }));
    const second = await plane.acquire(sessionScope({ workspaceRoot: "/workspace/source-b" }));

    expect(second.id).not.toBe(first.id);
    expect(second.acquisitionReason).toBe("workspace_root_changed");
    const inventory = await plane.inspect();
    expect(inventory.boxes.map((box) => box.createReason)).toEqual([
      "created",
      "workspace_root_changed",
    ]);
    expect(inventory.boxes.find((box) => box.id === first.id)?.supersededByBoxId).toBe(second.id);
  });

  test("normalizes workspaceRoot before computing the scope fingerprint", async () => {
    const plane = createInMemoryBoxPlane();
    const first = await plane.acquire(sessionScope({ workspaceRoot: "/tmp/brewva/source" }));
    const second = await plane.acquire(sessionScope({ workspaceRoot: "/tmp/brewva/source/" }));

    expect(second.id).toBe(first.id);
    expect(second.acquisitionReason).toBe("reused");
  });

  test("forked ephemeral child scopes are unique even when the fork name repeats", async () => {
    const plane = createInMemoryBoxPlane();
    const parent = await plane.acquire(sessionScope());

    const firstFork = await parent.fork("branch");
    const secondFork = await parent.fork("branch");

    expect(firstFork.scope.kind).toBe("ephemeral");
    expect(secondFork.scope.kind).toBe("ephemeral");
    expect(firstFork.scope.id).not.toBe(secondFork.scope.id);
    expect(firstFork.id).not.toBe(secondFork.id);
  });
});
