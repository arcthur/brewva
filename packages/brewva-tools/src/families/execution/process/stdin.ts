import { type ManagedExecRunningSession } from "../exec-process-registry/api.js";

export async function writeToStdin(
  session: ManagedExecRunningSession,
  data: string,
  eof: boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    session.stdin.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (eof) {
    session.stdin.end();
  }
}
