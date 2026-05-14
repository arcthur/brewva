import { randomUUID } from "node:crypto";

export function executionKey(boxId: string, executionId: string): string {
  return `${boxId}\0${executionId}`;
}

export function createUlidLikeId(prefix: string): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const random = randomUUID().replaceAll("-", "").slice(0, 16);
  return `${prefix}_${time}${random}`;
}
