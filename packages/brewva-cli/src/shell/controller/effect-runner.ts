import type { ShellEffect } from "../domain/effects.js";

export interface ShellEffectRunnerDelegate {
  isDisposed(): boolean;
  driveShellEffect(effect: ShellEffect): Promise<void>;
  reportShellEffectError(error: unknown, options: { errorMode?: "notify" | "throw" }): void;
}

export class ShellEffectRunner {
  constructor(private readonly delegate: ShellEffectRunnerDelegate) {}

  async run(
    effects: readonly ShellEffect[],
    options: { errorMode?: "notify" | "throw" } = {},
  ): Promise<void> {
    for (const effect of effects) {
      if (this.delegate.isDisposed()) {
        return;
      }
      try {
        await this.delegate.driveShellEffect(effect);
      } catch (error) {
        this.delegate.reportShellEffectError(error, options);
      }
    }
  }
}
