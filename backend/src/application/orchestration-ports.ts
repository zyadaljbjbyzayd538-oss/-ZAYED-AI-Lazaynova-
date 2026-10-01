import type { AgentExecutionContext, AgentResult, TaskStatus } from '../domain/types.js';
import type { AgentPlan, GraphNodeStatus, TaskGraphSnapshot } from '../domain/task-graph.js';

export interface Planner {
  isReady(): Promise<boolean>;
  plan(context: AgentExecutionContext): Promise<AgentPlan>;
}

export interface Executor {
  execute(context: AgentExecutionContext, snapshot: TaskGraphSnapshot): Promise<AgentResult>;
}

export interface ExecutionMonitor {
  onTaskState(taskId: string, status: TaskStatus, detail?: string): Promise<void>;
  onGraphNodeState(taskId: string, nodeId: string, status: GraphNodeStatus, attempt?: number): Promise<void>;
}

export interface ResultVerifier {
  verify(capability: AgentExecutionContext['capability'], result: AgentResult): Promise<{
    passed: boolean;
    evidence: AgentResult['evidence'];
    issues: string[];
  }>;
}

/**
 * Durable, idempotent persistence boundary for plans, graph-node checkpoints, and evidence.
 * Implementations must scope all records to the owning task and reject unknown node ids.
 */
export interface TaskGraphRepository {
  loadExecutionPlan(taskId: string): Promise<TaskGraphSnapshot | null>;
  saveExecutionPlan(taskId: string, plan: AgentPlan, planHash: string): Promise<void>;
  startGraphNode(taskId: string, nodeId: string): Promise<number | null>;
  completeGraphNode(taskId: string, nodeId: string, result: AgentResult): Promise<void>;
  failGraphNode(taskId: string, nodeId: string, safeCode: string): Promise<void>;
  blockGraphNode(taskId: string, nodeId: string): Promise<boolean>;
  persistEvidenceChain(taskId: string, evidence: AgentResult['evidence']): Promise<void>;
}

export type ToolInvocationContext = Pick<AgentExecutionContext, 'taskId' | 'userId' | 'capability' | 'signal' | 'resourceType'>;

/** Allowlisted invocation surface; implementations must re-check the task owner's permission per call. */
export interface ToolManager {
  isToolReady(name: string): Promise<boolean>;
  listAvailable(userId: string): Promise<Array<{ name: string; description: string }>>;
  invoke(context: ToolInvocationContext, name: string, input: unknown): Promise<unknown>;
}

/** TODO: Phase 4: store large output artifacts in object storage with retention and access policy. */
export interface ResultManager {
  store(taskId: string, result: AgentResult): Promise<void>;
}
