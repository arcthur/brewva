export interface ShellModelDialogOpener {
  openModelsDialog(input?: { query?: string; providerFilter?: string }): Promise<void>;
}

export class ShellModelDialogBridge implements ShellModelDialogOpener {
  #opener: ShellModelDialogOpener | undefined;

  bind(opener: ShellModelDialogOpener): void {
    this.#opener = opener;
  }

  async openModelsDialog(input?: { query?: string; providerFilter?: string }): Promise<void> {
    if (!this.#opener) {
      throw new Error("Model picker is not initialized.");
    }
    await this.#opener.openModelsDialog(input);
  }
}
