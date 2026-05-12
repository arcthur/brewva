export interface HostedSessionLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}
