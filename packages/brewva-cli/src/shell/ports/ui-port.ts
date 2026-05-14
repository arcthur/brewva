import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";

export interface CliShellUiPort extends BrewvaToolUiPort {
  copyText?(text: string): Promise<void>;
  openUrl?(url: string): Promise<void>;
}
