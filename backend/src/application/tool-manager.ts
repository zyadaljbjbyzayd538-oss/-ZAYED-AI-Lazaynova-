import { CapabilityPermissionError, CapabilityUnavailableError, HttpError } from '../domain/errors.js';
import { TOOL_BUDGETS, TOOL_CAPABILITIES, type TaskCapability, type ToolName } from '../domain/types.js';
import type { AuditRepository, AuthRepository } from './ports.js';
import type { ToolInvocationContext, ToolManager } from './orchestration-ports.js';

export interface AllowlistedTool<Input = unknown, Output = unknown> {
  name: ToolName;
  description: string;
  requiredCapability: TaskCapability;
  timeoutMilliseconds: number;
  callsPerMinute: number;
  callsPerDay: number;
  isReady(): Promise<boolean>;
  parseInput(input: unknown): Input;
  execute(context: ToolInvocationContext, input: Input, signal: AbortSignal): Promise<Output>;
}

/**
 * Strict allowlist with capability permission re-checks at each invocation, bounded time,
 * content-free audit records, and no mechanism for shell/URL/file-system escape tools.
 */
export class AllowlistedToolManager implements ToolManager {
  private readonly tools = new Map<string, AllowlistedTool>();

  constructor(
    private readonly auth: Pick<AuthRepository, 'hasCapability' | 'hasToolGrant' | 'consumeToolUsage'>,
    private readonly audit: Pick<AuditRepository, 'writeAudit'>,
    definitions: AllowlistedTool[],
  ) {
    for (const definition of definitions) {
      if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(definition.name) || this.tools.has(definition.name)) {
        throw new Error('Tool registry contains an invalid or duplicate tool name.');
      }
      if (TOOL_CAPABILITIES[definition.name] !== definition.requiredCapability) {
        throw new Error(`Tool ${definition.name} does not match the reviewed capability mapping.`);
      }
      if (!Number.isInteger(definition.timeoutMilliseconds) || definition.timeoutMilliseconds < 100 || definition.timeoutMilliseconds > 120_000) {
        throw new Error(`Tool ${definition.name} has an invalid timeout.`);
      }
      const budget = TOOL_BUDGETS[definition.name];
      if (
        !Number.isSafeInteger(definition.callsPerMinute) || definition.callsPerMinute < 1 ||
        !Number.isSafeInteger(definition.callsPerDay) || definition.callsPerDay < definition.callsPerMinute ||
        definition.callsPerMinute !== budget.callsPerMinute || definition.callsPerDay !== budget.callsPerDay
      ) {
        throw new Error(`Tool ${definition.name} has an invalid reviewed usage budget.`);
      }
      this.tools.set(definition.name, definition);
    }
  }

  async isToolReady(name: string): Promise<boolean> {
    const tool = this.tools.get(name);
    if (!tool) return false;
    try { return await tool.isReady(); } catch { return false; }
  }

  async listAvailable(userId: string): Promise<Array<{ name: string; description: string }>> {
    const candidates = await Promise.all([...this.tools.values()].map(async (tool) => {
      try {
        const [capabilityGranted, toolGranted, ready] = await Promise.all([
          this.auth.hasCapability(userId, tool.requiredCapability),
          this.auth.hasToolGrant(userId, tool.name),
          tool.isReady(),
        ]);
        return capabilityGranted && toolGranted && ready ? { name: tool.name, description: tool.description } : null;
      } catch {
        return null;
      }
    }));
    return candidates.filter((item): item is { name: ToolName; description: string } => item !== null);
  }

  async invoke(context: ToolInvocationContext, name: string, rawInput: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new HttpError(404, 'TOOL_NOT_FOUND', 'The requested tool is not allowlisted.');
    if (!context.taskId) throw new HttpError(400, 'TASK_ID_REQUIRED', 'Tools can only be called from a durable task.');
    if (context.capability !== tool.requiredCapability) {
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_PERMISSION_DENIED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, requiredCapability: tool.requiredCapability, actualCapability: context.capability },
      });
      throw new HttpError(403, 'TOOL_PERMISSION_DENIED', 'This task is not authorized to invoke the requested tool.');
    }
    if (!(await this.auth.hasCapability(context.userId, tool.requiredCapability))) {
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_PERMISSION_DENIED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, requiredCapability: tool.requiredCapability },
      });
      throw new CapabilityPermissionError();
    }
    if (!(await this.auth.hasToolGrant(context.userId, tool.name))) {
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_PERMISSION_DENIED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, reason: 'TOOL_GRANT_MISSING' },
      });
      throw new HttpError(403, 'TOOL_PERMISSION_DENIED', 'The account is not granted this tool.');
    }
    if (!(await this.isToolReady(name))) throw new CapabilityUnavailableError();

    let input: unknown;
    try { input = tool.parseInput(rawInput); } catch {
      throw new HttpError(400, 'TOOL_INPUT_INVALID', 'The tool input is invalid.');
    }

    const usage = await this.auth.consumeToolUsage(context.userId, tool.name, tool.callsPerMinute, tool.callsPerDay);
    if (usage !== 'ALLOWED') {
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_BUDGET_EXHAUSTED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, window: usage },
      });
      throw new HttpError(429, 'TOOL_BUDGET_EXHAUSTED', 'The usage limit for this tool has been reached.');
    }

    await this.audit.writeAudit({
      actorUserId: context.userId,
      action: 'TOOL_INVOKE_STARTED',
      resourceType: context.resourceType ?? 'task',
      resourceId: context.taskId,
      details: { toolName: tool.name, capability: tool.requiredCapability },
    });

    const timeoutController = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let onAbort: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        timeoutController.abort();
        reject(new HttpError(504, 'TOOL_TIMEOUT', 'The tool exceeded its execution deadline.'));
      }, tool.timeoutMilliseconds);
    });
    const cancelled = context.signal ? new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new HttpError(409, 'TASK_EXECUTION_CANCELLED', 'Task execution was cancelled.'));
      context.signal!.addEventListener('abort', onAbort, { once: true });
      if (context.signal!.aborted) onAbort();
    }) : null;

    try {
      const operation = Promise.resolve().then(() => tool.execute(context, input, signal));
      const output = await Promise.race(cancelled ? [operation, timeout, cancelled] : [operation, timeout]);
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_INVOKE_COMPLETED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, capability: tool.requiredCapability },
      });
      return output;
    } catch (error) {
      const reportedError = timedOut ? new HttpError(504, 'TOOL_TIMEOUT', 'The tool exceeded its execution deadline.') : error;
      const code = reportedError instanceof HttpError && /^[A-Z0-9_]{1,64}$/.test(reportedError.code) ? reportedError.code : 'TOOL_EXECUTION_FAILED';
      await this.audit.writeAudit({
        actorUserId: context.userId,
        action: 'TOOL_INVOKE_FAILED',
        resourceType: context.resourceType ?? 'task',
        resourceId: context.taskId,
        details: { toolName: tool.name, code },
      });
      if (reportedError instanceof HttpError) throw reportedError;
      throw new HttpError(502, 'TOOL_EXECUTION_FAILED', 'The requested tool could not complete.');
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && context.signal) context.signal.removeEventListener('abort', onAbort);
    }
  }
}
