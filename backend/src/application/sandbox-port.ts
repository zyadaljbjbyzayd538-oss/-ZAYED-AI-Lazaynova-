export interface SandboxExecutionRequest {
  projectId: string;
  userId: string;
  command: string;
  workspaceArchiveKey: string;
  timeoutMs: number;
  memoryMb: number;
  cpuQuota: number;
  networkAccess: 'NONE' | 'ALLOWLIST';
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  workspaceArchiveKey: string;
  startedAt: string;
  completedAt: string;
}

/** Isolated command-execution port; adapters must fail closed when a secure runtime or workspace is unavailable. */
export interface CodeExecutionSandbox {
  isReady(): Promise<boolean>;
  execute(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<SandboxExecutionResult>;
}
