export type IntegrityDomain = "event_tape" | "recovery_wal" | "artifact";

export type IntegritySeverity = "degraded" | "unavailable";

export interface IntegrityIssue {
  domain: IntegrityDomain;
  severity: IntegritySeverity;
  reason: string;
  sessionId?: string;
  eventId?: string;
  eventType?: string;
  index?: number;
}

export interface IntegrityStatus {
  status: "healthy" | "degraded" | "unavailable";
  issues: IntegrityIssue[];
}
