import { FrameScheduler } from "./frame-scheduler.js";

export interface HeadlessTerminalHarness {
  readonly writes: string[];
  readonly writer: {
    write(text: string): void;
  };
  createFrameScheduler(): FrameScheduler;
  read(): string;
  clear(): void;
}

export function createHeadlessTerminalHarness(): HeadlessTerminalHarness {
  const writes: string[] = [];

  return {
    writes,
    writer: {
      write(text: string) {
        writes.push(text);
      },
    },
    createFrameScheduler() {
      return new FrameScheduler(this.writer);
    },
    read() {
      return writes.join("");
    },
    clear() {
      writes.length = 0;
    },
  };
}
