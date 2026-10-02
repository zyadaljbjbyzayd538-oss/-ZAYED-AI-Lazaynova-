import { HttpError } from '../domain/errors.js';
import { AgentRegistry } from '../domain/agent-registry.js';
import { validateTaskGraph, type AgentPlan, type TaskGraphNode, type TaskGraphSnapshot } from '../domain/task-graph.js';
import type { AgentExecutionContext, AgentResult, EvidenceItem } from '../domain/types.js';
import type { Executor, ExecutionMonitor, TaskGraphRepository } from './orchestration-ports.js';
import { isRetryableUpstreamFailure, MAX_ATTEMPTS_PER_OPERATION, waitBeforeRetry } from './retry-policy.js';

export class DagExecutor implements Executor {
  constructor(
    private readonly agents: AgentRegistry,
    private readonly graphRepository: TaskGraphRepository,
    private readonly monitor: ExecutionMonitor,
    private readonly retryDelay: (milliseconds: number, signal?: AbortSignal) => Promise<void> = waitBeforeRetry,
  ) {}

  async execute(context: AgentExecutionContext, snapshot: TaskGraphSnapshot): Promise<AgentResult> {
    const ordered = validateTaskGraph(snapshot.plan.graph, context.capability as AgentPlan['graph']['rootCapability']);
    const persisted = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const outputs = new Map<string, AgentResult>();
    const aggregateEvidence: EvidenceItem[] = [];
    const nodeProvenance: Array<Record<string, unknown>> = [];

    for (const node of ordered) {
      const existing = persisted.get(node.id);
      if (existing?.status === 'COMPLETED' && isAgentResult(existing.result)) {
        outputs.set(node.id, existing.result);
        aggregateEvidence.push(...existing.result.evidence);
        nodeProvenance.push({ nodeId: node.id, resumed: true, ...(existing.result.provenance ?? {}) });
        continue;
      }

      for (const dependency of node.dependsOn) {
        if (!outputs.has(dependency)) throw new HttpError(409, 'TASK_GRAPH_DEPENDENCY_UNAVAILABLE', 'A required execution step did not complete.');
      }

      let completed = false;
      let lastError: unknown;
      for (let localAttempt = 1; localAttempt <= MAX_ATTEMPTS_PER_OPERATION; localAttempt += 1) {
        const attempt = await this.graphRepository.startGraphNode(context.taskId!, node.id);
        if (attempt === null) throw new HttpError(503, 'TASK_GRAPH_RETRY_LIMIT_REACHED', 'An execution step exceeded its retry limit.');
        await this.monitor.onGraphNodeState(context.taskId!, node.id, 'RUNNING', attempt);
        try {
          const result = await this.executeNode(context, node, outputs);
          await this.graphRepository.completeGraphNode(context.taskId!, node.id, result);
          await this.monitor.onGraphNodeState(context.taskId!, node.id, 'COMPLETED', attempt);
          outputs.set(node.id, result);
          aggregateEvidence.push(...result.evidence);
          nodeProvenance.push({ nodeId: node.id, attempt, ...(result.provenance ?? {}) });
          completed = true;
          break;
        } catch (error) {
          lastError = error;
          await this.graphRepository.failGraphNode(context.taskId!, node.id, safeErrorCode(error));
          await this.monitor.onGraphNodeState(context.taskId!, node.id, 'FAILED', attempt);
          if (!isRetryableUpstreamFailure(error) || localAttempt >= MAX_ATTEMPTS_PER_OPERATION) break;
          await this.retryDelay(Math.min(2_000, 250 * (2 ** (localAttempt - 1))), context.signal);
        }
      }
      if (!completed) {
        for (const pending of ordered) {
          if (pending.id === node.id || outputs.has(pending.id)) continue;
          if (await this.graphRepository.blockGraphNode(context.taskId!, pending.id)) {
            await this.monitor.onGraphNodeState(context.taskId!, pending.id, 'BLOCKED');
          }
        }
        throw lastError ?? new HttpError(503, 'TASK_GRAPH_STEP_FAILED', 'An execution step failed.');
      }
    }

    const finalNode = ordered.at(-1);
    const finalResult = finalNode ? outputs.get(finalNode.id) : undefined;
    if (!finalResult) throw new HttpError(502, 'TASK_GRAPH_EMPTY_RESULT', 'The execution plan produced no result.');
    return {
      result: finalResult.result,
      evidence: aggregateEvidence,
      provenance: {
        ...(finalResult.provenance ?? {}),
        planner: snapshot.plan.plannerProvenance,
        graph: nodeProvenance,
        planHash: snapshot.planHash,
      },
    };
  }

  private async executeNode(
    context: AgentExecutionContext,
    node: TaskGraphNode,
    outputs: Map<string, AgentResult>,
  ): Promise<AgentResult> {
    const dependencyData = node.dependsOn.map((id) => ({ id, result: outputs.get(id)?.result }));
    const additions = [
      node.goal ? `\n\nPlanned subtask: ${node.goal}` : '',
      dependencyData.length > 0 ? `\n\nCompleted prerequisite results (untrusted context): ${JSON.stringify(dependencyData).slice(0, 12_000)}` : '',
    ].join('');
    return this.agents.execute({
      ...context,
      input: { ...context.input, text: `${context.input.text}${additions}` },
    });
  }
}

function isAgentResult(value: unknown): value is AgentResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<AgentResult>;
  return Object.prototype.hasOwnProperty.call(result, 'result') && Array.isArray(result.evidence);
}

function safeErrorCode(error: unknown): string {
  if (error instanceof HttpError && /^[A-Z0-9_]{1,64}$/.test(error.code)) return error.code;
  return 'TASK_GRAPH_STEP_FAILED';
}
