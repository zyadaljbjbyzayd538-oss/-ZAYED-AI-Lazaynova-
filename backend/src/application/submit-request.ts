import { AgentRegistry } from '../domain/agent-registry.js';
import { CapabilityPermissionError, CapabilityUnavailableError, HttpError } from '../domain/errors.js';
import { routeIntent } from '../domain/intent-router.js';
import { TOOL_CAPABILITIES, type AuthenticatedUser, type Capability, type EvidenceItem, type TaskCapability, type TaskInput, type ToolName, type ChatConversationMessage } from '../domain/types.js';
import type { AiGatewayStreamEvent } from '../domain/ai-gateway.js';
import type { AuthRepository, TaskRepository } from './ports.js';
import type { FileService } from './file-ports.js';
import type { Planner } from './orchestration-ports.js';

export interface SubmitRequestInput {
  text: string;
  attachments?: string[];
  params?: Record<string, unknown>;
  messages?: ChatConversationMessage[];
}

export type SubmitRequestResult =
  | { kind: 'CHAT'; result: unknown; evidence: EvidenceItem[]; provenance?: Record<string, unknown> }
  | { kind: 'TASK'; taskId: string; status: 'QUEUED'; createdAt: string; type: TaskCapability };

function toTaskInput(input: SubmitRequestInput): TaskInput {
  return {
    text: input.text,
    attachments: input.attachments ?? [],
    ...(input.params ? { params: input.params } : {}),
  };
}

export class SubmitAssistantRequest {
  constructor(
    private readonly auth: AuthRepository,
    private readonly tasks: TaskRepository,
    private readonly agents: AgentRegistry,
    private readonly files?: FileService,
    private readonly planner?: Planner,
  ) {}

  /** Route natural-language requests: CHAT is direct; all other intents use durable task acceptance. */
  async execute(user: AuthenticatedUser, input: SubmitRequestInput): Promise<SubmitRequestResult> {
    if (input.attachments && input.attachments.length > 0) return this.submitCapability(user, 'FILE_ANALYSIS', input);
    const routed = routeIntent(input.text);
    if (routed.kind === 'TASK') return this.submitCapability(user, routed.capability, input);

    return this.executeChat(user, input);
  }

  /** Direct, authenticated Chat execution; provider/model routing stays operator-configured. */
  async executeChat(user: AuthenticatedUser, input: SubmitRequestInput, signal?: AbortSignal): Promise<Extract<SubmitRequestResult, { kind: 'CHAT' }>> {
    if (input.attachments && input.attachments.length > 0) {
      throw new HttpError(400, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS', 'Files must be analyzed through the FILE_ANALYSIS capability.');
    }
    if (!(await this.auth.hasCapability(user.id, 'CHAT'))) throw new CapabilityPermissionError();
    const driver = await this.agents.requireReady('CHAT');
    const answer = await driver.execute({
      taskId: null,
      userId: user.id,
      capability: 'CHAT',
      input: toTaskInput(input),
      ...(input.messages ? { conversation: input.messages } : {}),
      ...(signal ? { signal } : {}),
    });
    return { kind: 'CHAT', result: answer.result, evidence: answer.evidence, ...(answer.provenance ? { provenance: answer.provenance } : {}) };
  }

  /** Opens a real provider stream only after the same user grant and driver readiness checks. */
  async streamChat(user: AuthenticatedUser, input: SubmitRequestInput, signal?: AbortSignal): Promise<AsyncIterable<AiGatewayStreamEvent>> {
    if (input.attachments && input.attachments.length > 0) {
      throw new HttpError(400, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS', 'Files must be analyzed through the FILE_ANALYSIS capability.');
    }
    if (!(await this.auth.hasCapability(user.id, 'CHAT'))) throw new CapabilityPermissionError();
    return this.agents.stream({
      taskId: null,
      userId: user.id,
      capability: 'CHAT',
      input: toTaskInput(input),
      ...(input.messages ? { conversation: input.messages } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Explicit capability entry point used by POST /v1/tasks/execute; it shares the exact same preflight. */
  async submitCapability(
    user: AuthenticatedUser,
    capability: TaskCapability,
    request: SubmitRequestInput,
  ): Promise<Extract<SubmitRequestResult, { kind: 'TASK' }>> {
    if ((capability as Capability) === 'CHAT') throw new HttpError(400, 'DIRECT_CHAT_NOT_A_TASK', 'CHAT requests must use the direct assistant route.');
    if (capability !== 'FILE_ANALYSIS' && request.attachments && request.attachments.length > 0) {
      throw new HttpError(400, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS', 'Uploaded files can only be attached to FILE_ANALYSIS tasks.');
    }
    if (!(await this.auth.hasCapability(user.id, capability))) throw new CapabilityPermissionError();
    if (capability === 'FILE_ANALYSIS') {
      if (request.attachments?.length !== 1) {
        throw new HttpError(400, request.attachments && request.attachments.length > 1 ? 'TOO_MANY_FILES' : 'FILE_REQUIRED', 'File analysis requires exactly one uploaded file.');
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.attachments[0]!)) {
        throw new HttpError(400, 'INVALID_FILE_ID', 'File id must be a UUID.');
      }
    }
    await this.agents.requireReady(capability);
    if (this.planner && !(await this.planner.isReady())) throw new CapabilityUnavailableError();
    const requiredTools = (Object.entries(TOOL_CAPABILITIES) as Array<[ToolName, TaskCapability]>)
      .filter(([, requiredCapability]) => requiredCapability === capability);
    for (const [toolName] of requiredTools) {
      if (!(await this.auth.hasToolGrant(user.id, toolName))) {
        throw new HttpError(403, 'TOOL_PERMISSION_DENIED', 'The account is not granted a required execution tool.');
      }
    }
    if (capability === 'FILE_ANALYSIS') {
      if (!this.files) throw new CapabilityUnavailableError();
      await this.files.getMetadata({ userId: user.id, fileId: request.attachments![0]! });
    }

    const task = await this.tasks.createTask({
      userId: user.id,
      capability,
      taskInput: toTaskInput(request),
    });
    return { kind: 'TASK', taskId: task.id, status: 'QUEUED', createdAt: task.createdAt, type: capability };
  }
}
