import { z } from 'zod';
import type { AgentResult, EvidenceItem, TaskInput, TaskCapability } from './types.js';
import type { WorkflowStepDefinition } from './workflow-definition.js';

export const workflowRunInputSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  attachments: z.array(z.string().uuid()).max(1).optional(),
  version: z.number().int().min(1).max(999_999_999).optional(),
}).strict();

export type WorkflowRunInput = z.infer<typeof workflowRunInputSchema>;
export type WorkflowRunStatus = 'QUEUED' | 'RUNNING' | 'WAITING_APPROVAL' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type WorkflowRunStepStatus = 'PENDING' | 'WAITING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'BLOCKED';
export type WorkflowApprovalDecision = 'APPROVE' | 'REJECT';

export interface WorkflowRunStepRecord extends WorkflowStepDefinition {
  status: WorkflowRunStepStatus;
  attempts: number;
  result: AgentResult | null;
  errorCode: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}

export interface WorkflowRunRecord {
  runId: string;
  ownerId: string;
  workflowId: string;
  workflowName: string;
  version: number;
  status: WorkflowRunStatus;
  input: TaskInput;
  steps: WorkflowRunStepRecord[];
  result: { outputs: Array<{ stepId: string; capability: TaskCapability; result: unknown }> } | null;
  evidence: EvidenceItem[] | null;
  errorCode: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** Public owner-scoped polling representation; excludes the original prompt and stored step prompts. */
export interface WorkflowRunStepView extends Omit<WorkflowRunStepRecord, 'prompt' | 'dependsOn' | 'result'> {
  result: unknown | null;
}

export interface WorkflowRunView extends Omit<WorkflowRunRecord, 'input' | 'steps' | 'evidence' | 'ownerId'> {
  steps: WorkflowRunStepView[];
  evidenceCount: number;
}

export function toWorkflowRunView(run: WorkflowRunRecord): WorkflowRunView {
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    version: run.version,
    status: run.status,
    steps: run.steps.map(({ prompt: _prompt, dependsOn: _dependsOn, result, ...step }) => ({ ...step, result: result?.result ?? null })),
    result: run.result,
    errorCode: run.errorCode,
    cancelRequested: run.cancelRequested,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    evidenceCount: run.evidence?.length ?? 0,
  };
}

export interface WorkflowRunCreateRecord {
  ownerId: string;
  workflowId: string;
  workflowName: string;
  version: number;
  input: TaskInput;
  steps: WorkflowStepDefinition[];
}

export interface WorkflowRunStepCompletion {
  runId: string;
  stepId: string;
  leaseOwner: string;
  result: AgentResult;
}

export type WorkflowRunClaimResult = 'CLAIMED' | 'NOT_CLAIMED' | 'CANCELLED';
