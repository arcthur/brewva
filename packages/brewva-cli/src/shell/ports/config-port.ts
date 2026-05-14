export interface ConfigPort {
  getEditorCommand(): string | undefined;
}

export type ShellConfigPort = ConfigPort;
