import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = join(import.meta.dir, "..", "..", "..");
export const gatewayRoot = join(repoRoot, "packages", "brewva-gateway", "src");

export function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

export function gatewayPath(...segments: string[]): string {
  return join(gatewayRoot, ...segments);
}

export function gatewayRelative(...segments: string[]): string {
  return join("packages", "brewva-gateway", "src", ...segments);
}

export function listGatewayProductionFiles(): string[] {
  const files: string[] = [];
  const visit = (absoluteDir: string, relativeDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolutePath = join(absoluteDir, entry.name);
      const relativePath = join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile() && relativePath.endsWith(".ts")) {
        files.push(relativePath.replaceAll("\\", "/"));
      }
    }
  };
  visit(gatewayRoot, gatewayRelative());
  return files.toSorted();
}

export function expectGatewayFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => !existsSync(join(repoRoot, path)));
}
