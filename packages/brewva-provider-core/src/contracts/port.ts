export interface ProviderSessionResources {
  clearSession(sessionId: string): void | Promise<void>;
}
