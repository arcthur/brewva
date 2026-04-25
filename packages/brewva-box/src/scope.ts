import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { BoxCapabilitySet, BoxScope } from "./contract.js";
import { stableStringify } from "./internal/stable-json.js";

export function normalizeBoxCapabilitySet(input: BoxCapabilitySet): BoxCapabilitySet {
  return {
    network:
      input.network.mode === "allowlist"
        ? {
            mode: "allowlist",
            allow: [...new Set(input.network.allow.map((host) => host.trim().toLowerCase()))]
              .filter(Boolean)
              .toSorted(),
          }
        : { mode: "off" },
    gpu: input.gpu,
    extraVolumes: input.extraVolumes
      .map((volume) => ({
        hostPath: resolve(volume.hostPath),
        guestPath: volume.guestPath,
        readonly: volume.readonly === true,
      }))
      .toSorted((left, right) =>
        `${left.guestPath}\0${left.hostPath}`.localeCompare(
          `${right.guestPath}\0${right.hostPath}`,
        ),
      ),
    secrets: [...new Set(input.secrets.map((secret) => secret.trim()).filter(Boolean))].toSorted(),
    ports: input.ports
      .map((port) => ({
        guest: port.guest,
        host: port.host,
        protocol: port.protocol ?? "tcp",
      }))
      .toSorted((left, right) =>
        `${left.protocol}\0${left.guest}\0${left.host ?? ""}`.localeCompare(
          `${right.protocol}\0${right.guest}\0${right.host ?? ""}`,
        ),
      ),
  };
}

export function normalizeBoxScope(scope: BoxScope): BoxScope {
  return {
    ...scope,
    workspaceRoot: resolve(scope.workspaceRoot),
    capabilities: normalizeBoxCapabilitySet(scope.capabilities),
  };
}

export function fingerprintBoxScope(scope: BoxScope): string {
  const normalized = normalizeBoxScope(scope);
  const canonical = {
    kind: normalized.kind,
    id: normalized.id,
    image: normalized.image,
    workspaceRoot: normalized.workspaceRoot,
    capabilities: normalized.capabilities,
  };
  return hashJson(canonical);
}

export function sameLineage(left: BoxScope, right: BoxScope): boolean {
  return left.kind === right.kind && left.id === right.id && left.image === right.image;
}

export function sameWorkspace(left: BoxScope, right: BoxScope): boolean {
  return sameLineage(left, right) && left.workspaceRoot === right.workspaceRoot;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
