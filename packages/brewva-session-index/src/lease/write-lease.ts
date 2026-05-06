import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const WRITE_LEASE_HEARTBEAT_MS = 30_000;
const WRITE_LEASE_STALE_MS = 10 * 60_000;

export interface WriteLease {
  acquired: boolean;
  release(): void;
}

export function acquireWriteLease(lockPath: string): WriteLease {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeWriteLeaseFile(fd, process.pid);
      const heartbeat = setInterval(() => {
        try {
          writeFileSync(lockPath, writeLeaseContent(process.pid), "utf8");
        } catch {}
      }, WRITE_LEASE_HEARTBEAT_MS);
      if (typeof heartbeat === "object" && heartbeat !== null && "unref" in heartbeat) {
        (heartbeat as { unref(): void }).unref();
      }
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          try {
            closeSync(fd);
          } catch {}
          try {
            unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch {
      if (attempt === 0 && removeStaleWriteLease(lockPath)) {
        continue;
      }
      return {
        acquired: false,
        release: () => {},
      };
    }
  }
  return {
    acquired: false,
    release: () => {},
  };
}

function writeWriteLeaseFile(fd: number, pid: number): void {
  writeFileSync(fd, writeLeaseContent(pid), "utf8");
}

function writeLeaseContent(pid: number): string {
  return `${pid}\n${Date.now()}\n`;
}

function removeStaleWriteLease(lockPath: string): boolean {
  let content = "";
  try {
    content = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  if (!isWriteLeaseStale(content)) {
    return false;
  }
  try {
    if (readFileSync(lockPath, "utf8") !== content) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isWriteLeaseStale(content: string, now = Date.now()): boolean {
  const [pidText, timestampText] = content.split(/\r?\n/u);
  const pid = Number(pidText);
  const timestamp = Number(timestampText);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  if (!isProcessRunning(pid)) {
    return true;
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return true;
  }
  return now - timestamp > WRITE_LEASE_STALE_MS;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
    return code === "EPERM";
  }
}
