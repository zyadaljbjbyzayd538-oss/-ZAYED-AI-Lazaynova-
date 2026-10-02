import type { AiGateway } from '../domain/ai-gateway.js';
import { HttpError } from '../domain/errors.js';
import { validateTaskGraph, TASK_GRAPH_OPERATIONS, type AgentPlan, type TaskGraph } from '../domain/task-graph.js';
import type { TaskCapability, AgentExecutionContext } from '../domain/types.js';
import type { Planner } from './orchestration-ports.js';

const MAX_PLAN_OUTPUT_CHARS = 12_000;

function toUsageContext(context: AgentExecutionContext) {
  return {
    userId: context.userId,
    resourceType: context.resourceType === 'workflow_run' ? 'WORKFLOW_RUN' as const : context.taskId ? 'TASK' as const : 'CHAT' as const,
    ...(context.taskId ? { resourceId: context.taskId } : {}),
  };
}

/**
 * Optional model-backed planner. It can only produce same-capability RUN_CAPABILITY nodes;
 * arbitrary tools, capability escalation, and cross-capability plans are rejected.
 */
export class ModelTaskPlanner implements Planner {
  constructor(private readonly gateway: AiGateway) {}

  isReady(): Promise<boolean> {
    return this.gateway.isReady();
  }

  async plan(context: AgentExecutionContext): Promise<AgentPlan> {
    const response = await this.gateway.generate({
      accountingContext: toUsageContext(context),
      systemPrompt: [
        'You are a task planner for a restricted agent engine.',
        'Return exactly one JSON object, without markdown or prose, matching:',
        '{"version":1,"rootCapability":"...","nodes":[{"id":"step-1","capability":"...","operation":"RUN_CAPABILITY","goal":"...","dependsOn":[]}]}',
        'Use only the provided root capability and operation RUN_CAPABILITY.',
        'Use 1 to 6 nodes. Keep each goal concise, factual, and under 300 characters.',
        'Use dependencies to describe ordering. Do not include credentials, tool names, URLs, file contents, or user data beyond a short task goal.',
        'For WEB_RESEARCH and FILE_ANALYSIS, use exactly one node. Their registered drivers already perform their retrieval or parsing workflow.',
      ].join('\n'),
      messages: [{
        role: 'user',
        content: JSON.stringify({
          capability: context.capability,
          request: context.input.text.slice(0, 8_000),
          attachmentCount: context.input.attachments.length,
        }),
      }],
      maxOutputTokens: 1_000,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    if (response.text.length > MAX_PLAN_OUTPUT_CHARS) {
      throw new HttpError(502, 'PLANNER_OUTPUT_INVALID', 'The task planner returned an invalid execution plan.');
    }
    let graph: TaskGraph;
    try {
      graph = JSON.parse(response.text) as TaskGraph;
      validateTaskGraph(graph, context.capability as TaskCapability);
      if ((context.capability === 'WEB_RESEARCH' || context.capability === 'FILE_ANALYSIS') && graph.nodes.length !== 1) {
        throw new Error('This capability must use a single graph node.');
      }
      if (graph.nodes.some((node) => node.goal.length > 300 || !TASK_GRAPH_OPERATIONS.includes(node.operation))) {
        throw new Error('The execution plan exceeded planner constraints.');
      }
    } catch {
      throw new HttpError(502, 'PLANNER_OUTPUT_INVALID', 'The task planner returned an invalid execution plan.');
    }
    if (!response.evidence.some((item) => item.kind === 'model_execution')) {
      throw new HttpError(502, 'PLANNER_EVIDENCE_MISSING', 'The task planner did not provide verifiable execution evidence.');
    }

    return {
      graph,
      plannerEvidence: response.evidence,
      plannerProvenance: {
        provider: response.provider,
        model: response.model,
        requestId: response.requestId,
      },
    };
  }
}
