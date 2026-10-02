import type { WorkflowApprovalDecision, WorkflowRunCreateRecord, WorkflowRunRecord, WorkflowRunStepRecord } from '../domain/workflow-run.js';
import type { AgentResult, EvidenceItem } from '../domain/types.js';

export type ApprovalResult = 'APPROVED' | 'REJECTED' | 'NOT_FOUND' | 'NOT_WAITING';
export type WorkflowCancelResult = 'CANCELLED' | 'ALREADY_CANCELLED' | 'NOT_FOUND' | 'NOT_CANCELLABLE';
export type WorkflowLeaseResult = 'RENEWED' | 'CANCELLED' | 'LOST';

/** Persistence boundary for immutable workflow-run snapshots, approvals, checkpoints and cancellation. */
export interface WorkflowRunRepository {
  createWorkflowRun(input: WorkflowRunCreateRecord): Promise<WorkflowRunRecord>;
  findWorkflowRun(runId: string, ownerId: string): Promise<WorkflowRunRecord | null>;
  findWorkflowRunForWorker(runId: string): Promise<WorkflowRunRecord | null>;
  claimWorkflowRun(runId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean>;
  renewWorkflowRunLease(runId: string, leaseOwner: string, leaseMilliseconds: number): Promise<WorkflowLeaseResult>;
  releaseWorkflowRunLease(runId: string, leaseOwner: string): Promise<void>;
  markWorkflowStepWaitingApproval(runId: string, stepId: string, leaseOwner: string): Promise<boolean>;
  startWorkflowStep(runId: string, stepId: string, leaseOwner: string): Promise<number | null>;
  completeWorkflowStep(runId: string, stepId: string, leaseOwner: string, result: AgentResult): Promise<boolean>;
  failWorkflowStep(runId: string, stepId: string, leaseOwner: string, code: string): Promise<boolean>;
  blockPendingWorkflowSteps(runId: string, leaseOwner: string): Promise<void>;
  completeWorkflowRun(runId: string, leaseOwner: string, result: WorkflowRunRecord['result'], evidence: EvidenceItem[]): Promise<boolean>;
  failWorkflowRun(runId: string, leaseOwner: string, code: string): Promise<boolean>;
  decideWorkflowApproval(ownerId: string, runId: string, stepId: string, decision: WorkflowApprovalDecision): Promise<ApprovalResult>;
  cancelWorkflowRun(ownerId: string, runId: string): Promise<WorkflowCancelResult>;
  /** Returns a copy with a changed step list suitable for serializing the snapshot into JSONB. */
  hydrateWorkflowSteps?(steps: WorkflowRunStepRecord[]): WorkflowRunStepRecord[];
}
