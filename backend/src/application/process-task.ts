import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '../domain/agent-registry.js';
import { CapabilityPermissionError, CapabilityUnavailableError, HttpError } from '../domain/errors.js';
import type { AgentExecutionContext, TaskStatus } from '../domain/types.js';
import { AgentEngine } from './agent-engine.js';
import { CapabilityPlanner } from './capability-planner.js';
import { DagExecutor } from './dag-executor.js';
import { DomainResultVerifier } from './domain-result-verifier.js';
import type { AuditRepository, AuthRepository, TaskRepository } from './ports.js';
import type { TaskEventSource } from './task-events.js';
import type { ExecutionMonitor, TaskGraphRepository } from './orchestration-ports.js';
import { PersistentExecutionMonitor } from './persistent-execution-monitor.js';

const LEASE_MILLISECONDS = 60_000;
const LEASE_HEARTBEAT_MILLISECONDS = 5_000;
const SAFE_ADAPTER_CODES = new Set([
  'AI_GATEWAY_REQUEST_FAILED',
  'AI_USAGE_ACCOUNTING_FAILED',
  'RESEARCH_PROVIDER_REQUEST_FAILED',
  'RESEARCH_NO_VERIFIABLE_SOURCES',
  'FILE_SERVICE_UNAVAILABLE',
  'FILE_NOT_FOUND',
  'FILE_CONTENT_UNAVAILABLE',
  'FILE_INTEGRITY_CHECK_FAILED',
  'PLANNER_OUTPUT_INVALID',
  'PLANNER_EVIDENCE_MISSING',
  'TASK_PLAN_INTEGRITY_FAILED',
  'TASK_PLAN_PERSISTENCE_FAILED',
  'TASK_GRAPH_RETRY_LIMIT_REACHED',
  'TOOL_PERMISSION_DENIED',
  'TOOL_BUDGET_EXHAUSTED',
  'TOOL_INPUT_INVALID',
  'TOOL_TIMEOUT',
  'TOOL_EXECUTION_FAILED',
  'TOOL_OUTPUT_INVALID',
]);
const SAFE_FAILURE_MESSAGES: Record<string, string> = {
  CAPABILITY_PERMISSION_REQUIRED: 'Capability permission was revoked before worker execution.',
  CAPABILITY_UNAVAILABLE: 'The execution engine became unavailable after task acceptance.',
  AI_GATEWAY_REQUEST_FAILED: 'The configured model provider could not complete this task.',
  AI_USAGE_ACCOUNTING_FAILED: 'Provider usage could not be recorded; the provider result was withheld.',
  RESEARCH_PROVIDER_REQUEST_FAILED: 'The configured research provider could not complete this task.',
  RESEARCH_NO_VERIFIABLE_SOURCES: 'The research provider returned no verifiable source content.',
  FILE_SERVICE_UNAVAILABLE: 'This task requires an encrypted file service that is not configured.',
  FILE_NOT_FOUND: 'The requested file is no longer available to this account.',
  FILE_CONTENT_UNAVAILABLE: 'The encrypted file cannot be opened with the configured key version.',
  FILE_INTEGRITY_CHECK_FAILED: 'Stored file integrity verification failed.',
  PLANNER_OUTPUT_INVALID: 'The configured planner returned a plan that failed validation.',
  PLANNER_EVIDENCE_MISSING: 'The configured planner did not provide verifiable execution evidence.',
  TASK_PLAN_INTEGRITY_FAILED: 'The saved execution plan failed its integrity check.',
  TASK_PLAN_PERSISTENCE_FAILED: 'The execution plan could not be safely stored.',
  TASK_GRAPH_RETRY_LIMIT_REACHED: 'An execution step exceeded its retry limit.',
  TOOL_PERMISSION_DENIED: 'The task is not authorized to invoke the required tool.',
  TOOL_BUDGET_EXHAUSTED: 'The tool usage limit was reached for this account.',
  TOOL_INPUT_INVALID: 'The execution plan provided invalid input to a tool.',
  TOOL_TIMEOUT: 'An allowlisted tool exceeded its execution deadline.',
  TOOL_EXECUTION_FAILED: 'An allowlisted tool could not complete this task.',
  TOOL_OUTPUT_INVALID: 'A tool returned evidence that failed validation.',
};
const ACTIVE_STATUSES = new Set<TaskStatus>(['PLANNING', 'RUNNING', 'WAITING', 'VERIFYING']);

export class ProcessTask {
  private readonly engine: AgentEngine;

  constructor(
    private readonly auth: AuthRepository,
    private readonly tasks: TaskRepository,
    private readonly audit: AuditRepository,
    private readonly agents: AgentRegistry,
    engine?: AgentEngine,
    private readonly taskEvents?: Pick<TaskEventSource, 'subscribe'>,
  ) {
    if (engine) {
      this.engine = engine;
    } else {
      const graphRepository = tasks as unknown as TaskGraphRepository;
      const monitor = new PersistentExecutionMonitor(tasks);
      this.engine = new AgentEngine(
        new CapabilityPlanner(),
        new DagExecutor(agents, graphRepository, monitor),
        graphRepository,
        monitor,
        new DomainResultVerifier(),
      );
    }
  }

  async execute(taskId: string): Promise<void> {
    const leaseOwner = randomUUID();
    if (!(await this.tasks.claimTaskExecution(taskId, leaseOwner, LEASE_MILLISECONDS))) return;

    const abortController = new AbortController();
    let unsubscribeCancellation = () => {};
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void this.tasks.renewTaskExecutionLease(taskId, leaseOwner, LEASE_MILLISECONDS)
        .then((renewed) => {
          if (!renewed) abortController.abort();
        })
        .catch(() => abortController.abort())
        .finally(() => { heartbeatRunning = false; });
    }, LEASE_HEARTBEAT_MILLISECONDS);
    heartbeat.unref?.();

    try {
      const task = await this.tasks.findTaskForWorker(taskId);
      if (!task || task.status !== 'PLANNING') return;
      unsubscribeCancellation = this.taskEvents?.subscribe(taskId, task.userId, (event) => {
        if (event.status === 'CANCELLED' || event.status === 'COMPLETED' || event.status === 'FAILED') abortController.abort();
      }) ?? (() => {});
      const executionState = await this.tasks.findTaskExecutionState(taskId);
      if (!executionState || executionState.userId !== task.userId || executionState.status !== 'PLANNING' || abortController.signal.aborted) return;
      await this.tasks.appendTaskLog(taskId, 'INFO', 'Worker claimed task lease; authorization and capability are being rechecked.');
      if (!(await this.auth.hasCapability(task.userId, task.type))) throw new CapabilityPermissionError();
      await this.agents.requireReady(task.type);
      if (!(await this.tasks.transitionTask(taskId, 'PLANNING', 'RUNNING', { leaseOwner }))) return;

      const context: AgentExecutionContext = {
        taskId,
        userId: task.userId,
        capability: task.type,
        input: task.input,
        signal: abortController.signal,
      };
      const execution = await this.engine.execute(context);
      if (abortController.signal.aborted) return;
      if (!(await this.tasks.transitionTask(taskId, 'RUNNING', 'VERIFYING', { leaseOwner }))) return;

      const verification = execution.verification;
      if (!verification.passed) {
        const message = 'The execution did not provide the evidence required for verification.';
        if (!(await this.tasks.transitionTask(taskId, 'VERIFYING', 'FAILED', {
          error: { code: 'VERIFICATION_EVIDENCE_REQUIRED', message },
          verification,
          leaseOwner,
        }))) return;
        await this.tasks.appendTaskLog(taskId, 'ERROR', `VERIFICATION_EVIDENCE_REQUIRED: ${verification.issues.join(', ')}`);
        await this.audit.writeAudit({
          actorUserId: null,
          action: 'TASK_VERIFICATION_FAILED',
          resourceType: 'task',
          resourceId: taskId,
          details: { code: 'VERIFICATION_EVIDENCE_REQUIRED', issues: verification.issues },
        });
        return;
      }

      if (!(await this.tasks.transitionTask(taskId, 'VERIFYING', 'COMPLETED', {
        result: { output: execution.agentResult.result, provenance: execution.agentResult.provenance ?? {} },
        verification,
        leaseOwner,
      }))) return;
      await this.audit.writeAudit({
        actorUserId: null,
        action: 'TASK_COMPLETED',
        resourceType: 'task',
        resourceId: taskId,
        details: {
          capability: task.type,
          provenance: execution.agentResult.provenance ?? {},
          evidenceCount: verification.evidence.length,
          evidenceChainRoot: execution.evidenceChainRoot,
        },
      });
    } catch (error) {
      const code = error instanceof CapabilityPermissionError || error instanceof CapabilityUnavailableError
        ? error.code
        : error instanceof HttpError && SAFE_ADAPTER_CODES.has(error.code)
          ? error.code
          : 'AGENT_EXECUTION_FAILED';
      const message = SAFE_FAILURE_MESSAGES[code] ?? 'Agent execution failed. Review server diagnostics using the task id.';
      const current = await this.tasks.findTaskForWorker(taskId);
      if (current && ACTIVE_STATUSES.has(current.status)) {
        const transitioned = await this.tasks.transitionTask(taskId, current.status, 'FAILED', {
          error: { code, message },
          leaseOwner,
        });
        if (transitioned) {
          await this.tasks.appendTaskLog(taskId, 'ERROR', `${code}: ${message}`);
          await this.audit.writeAudit({ actorUserId: null, action: 'TASK_FAILED', resourceType: 'task', resourceId: taskId, details: { code } });
        }
      }
    } finally {
      unsubscribeCancellation();
      clearInterval(heartbeat);
      await this.tasks.releaseTaskExecutionLease(taskId, leaseOwner).catch(() => undefined);
    }
  }
}
