import type {
  Json,
  RuntimePort,
  TargetCapabilities,
  TargetConfig,
  TargetOutput,
  ExternalTargetConfig,
  PublicQuestion,
} from "../../contracts.js";

export type TargetInvocation = Parameters<RuntimePort["execute"]>[0];
export type TargetAdapterOutput = TargetOutput & {
  cleanup: "complete" | "unavailable";
  evidenceScope: "answer-only" | "internal-activity";
};
export interface TargetRecovery {
  target: TargetConfig;
  checkpoint: Json;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface TargetCredentialBinding {
  required: boolean;
  reference?: string;
  bind(reference: string | undefined): ExternalTargetConfig;
}
export interface TargetAdapter {
  readonly id: string;
  readonly version: number;
  readonly capabilities: TargetCapabilities;
  validate(target: TargetConfig): TargetConfig;
  credentials?(target: ExternalTargetConfig): TargetCredentialBinding;
  preview?(target: TargetConfig, question: PublicQuestion): Json;
  resolve(target: TargetConfig): Promise<TargetConfig>;
  /** Return received answers even when cleanup is unavailable. Rejections with unresolved resources must use code cleanup_failed. */
  invoke(input: TargetInvocation): Promise<TargetAdapterOutput>;
  /** Use the supplied frozen configuration and signal; never retry the original target request. */
  recover(input: TargetRecovery): Promise<{
    cleanup: "complete" | "unavailable";
    remoteCompletion: "unknown" | "not-dispatched";
  }>;
  close(): Promise<void>;
}
