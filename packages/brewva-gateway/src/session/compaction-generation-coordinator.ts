export type CompactionRecoveryMode = "background" | "settled";

export interface CompactionGenerationCoordinator {
  readonly sessionId: string;
  getRequestedGeneration(): number;
  getCompletedGeneration(): number;
  waitForSettled(afterGeneration?: number): Promise<void>;
  dispose(): void;
  installMode(mode: CompactionRecoveryMode): void;
}
