import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../../io/external-process.js";
import type { CliShellUiPort } from "../ports/ui-port.js";

export interface ShellExternalProcessOptions {
  openExternalEditor?(title: string, prefill?: string): Promise<string | undefined>;
  openExternalPager?(title: string, lines: readonly string[]): Promise<boolean>;
  openExternalTranscriptPager?(): Promise<boolean>;
}

export interface ShellExternalProcessContext {
  getEditorCommand(): string | undefined;
  getUi(): CliShellUiPort;
}

export class ShellExternalProcessController {
  constructor(
    private readonly options: ShellExternalProcessOptions,
    private readonly context: ShellExternalProcessContext,
  ) {}

  async openEditor(title: string, prefill?: string): Promise<string | undefined> {
    if (this.options.openExternalEditor) {
      return await this.options.openExternalEditor(title, prefill);
    }
    const editor = this.context.getEditorCommand();
    if (!editor) {
      this.context.getUi().notify("No VISUAL or EDITOR is configured.", "warning");
      return prefill;
    }
    return await openExternalEditorWithShell(editor, title, prefill);
  }

  async openPager(title: string, lines: readonly string[]): Promise<boolean> {
    if (this.options.openExternalPager) {
      return await this.options.openExternalPager(title, lines);
    }
    const pager = getExternalPagerCommand();
    if (!pager) {
      return false;
    }
    return await openExternalPagerWithShell(pager, title, lines);
  }

  async openTranscriptPager(): Promise<boolean> {
    if (this.options.openExternalTranscriptPager) {
      return await this.options.openExternalTranscriptPager();
    }
    return false;
  }
}
