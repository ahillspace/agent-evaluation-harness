import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ProcessLaunch {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  processLimit: number;
}

export interface ProcessScope {
  child: ChildProcessWithoutNullStreams;
  stop(): void;
}

/** Platform infrastructure only; product lifecycle remains in application services. */
export interface ProcessDriver {
  readonly capabilities: { hardDescendantLimit: boolean };
  recover(): Promise<{ recovered: number }>;
  prepare(id: string): Promise<void>;
  launch(input: ProcessLaunch): Promise<ProcessScope>;
  cleanup(id: string): Promise<void>;
}
