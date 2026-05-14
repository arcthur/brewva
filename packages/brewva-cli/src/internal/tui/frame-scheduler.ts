const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[?25l";
const EXIT_ALT_SCREEN = "\u001b[?25h\u001b[?1049l";
const RESET_CURSOR = "\u001b[H\u001b[2J";

export interface FrameWriter {
  write(text: string): void;
}

export interface FrameSchedulerOptions {
  useAlternateScreen?: boolean;
}

export class FrameScheduler {
  readonly #writer: FrameWriter;
  readonly #useAlternateScreen: boolean;
  #entered = false;
  #lastFrame = "";

  constructor(writer: FrameWriter, options: FrameSchedulerOptions = {}) {
    this.#writer = writer;
    this.#useAlternateScreen = options.useAlternateScreen !== false;
  }

  enter(): void {
    if (this.#entered) {
      return;
    }
    this.#entered = true;
    if (this.#useAlternateScreen) {
      this.#writer.write(ENTER_ALT_SCREEN);
    }
  }

  flush(frame: string): void {
    if (!this.#entered) {
      this.enter();
    }
    if (frame === this.#lastFrame) {
      return;
    }
    this.#lastFrame = frame;
    this.#writer.write(`${RESET_CURSOR}${frame}`);
  }

  exit(): void {
    if (!this.#entered) {
      return;
    }
    this.#entered = false;
    this.#lastFrame = "";
    if (this.#useAlternateScreen) {
      this.#writer.write(EXIT_ALT_SCREEN);
    }
  }
}
