export interface BrewvaShellConfig {
  shell: string;
  args: string[];
}

export function resolveShellConfig(): BrewvaShellConfig {
  if (process.platform === "win32") {
    return {
      shell: process.env.COMSPEC || "cmd.exe",
      args: ["/d", "/s", "/c"],
    };
  }

  return {
    shell: process.env.SHELL || "/bin/sh",
    args: ["-lc"],
  };
}
