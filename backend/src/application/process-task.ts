import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '../domain/agent-registry.js';
import { CapabilityPermissionError, CapabilityUnavailableError, HttpError } from '../domain/errors.js';
import type { AgentExecutionContext, TaskStatus } from '../domain/types.js';
import { INLINE_RESULT_MAX_BYTES, MAX_TASK_ARTIFACT_BYTES, type TaskArtifactReference, type TaskArtifactWriter } from './artifact-ports.js';
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
  'ARTIFACT_STORAGE_UNAVAILABLE',
  'ARTIFACT_STORAGE_FAILED',
  'ARTIFACT_METADATA_FAILED',
  'ARTIFACT_CLEANUP_FAILED',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_INTEGRITY_CHECK_FAILED',
  'TASK_RESULT_SERIALIZATION_FAILED',
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
  ARTIFACT_STORAGE_UNAVAILABLE: 'External result storage is required for this result but is not configured.',
  ARTIFACT_STORAGE_FAILED: 'External artifact storage could not save the result.',
  ARTIFACT_METADATA_FAILED: 'Artifact metadata could not be stored safely.',
  ARTIFACT_CLEANUP_FAILED: 'An unreferenced artifact could not be removed safely.',
  ARTIFACT_TOO_LARGE: 'The result exceeded the configured external artifact size limit.',
  ARTIFACT_INTEGRITY_CHECK_FAILED: 'A stored result failed its integrity check.',
  TASK_RESULT_SERIALIZATION_FAILED: 'The task result could not be stored safely.',
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

function encodeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined JSON');
    return encoded;
  } catch {
    throw new HttpError(503, 'TASK_RESULT_SERIALIZATION_FAILED', 'The task result could not be stored safely.');
  }
}

function asTaskArtifactReference(value: unknown, taskId: string): TaskArtifactReference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reference = value as Partial<TaskArtifactReference>;
  if (typeof reference.artifactId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference.artifactId) ||
      reference.taskId !== taskId || !['TASK_RESULT', 'GRAPH_NODE_RESULT'].includes(reference.kind ?? '') ||
      typeof reference.filename !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(reference.filename) ||
      reference.contentType !== 'application/json' || typeof reference.downloadPath !== 'string' || reference.downloadPath !== `/v1/artifacts/${reference.artifactId}/content` ||
      !Number.isSafeInteger(reference.byteLength) || (reference.byteLength ?? 0) < 1 || (reference.byteLength ?? 0) > MAX_TASK_ARTIFACT_BYTES ||
      typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(reference.sha256) ||
      typeof reference.createdAt !== 'string' || !Number.isFinite(Date.parse(reference.createdAt))) return null;
  return reference as TaskArtifactReference;
}

export class ProcessTask {
  private readonly engine: AgentEngine;

  constructor(
    private readonly auth: AuthRepository,
    private readonly tasks: TaskRepository,
    private readonly audit: AuditRepository,
    private readonly agents: AgentRegistry,
    engine?: AgentEngine,
    private readonly taskEvents?: Pick<TaskEventSource, 'subscribe'>,
    private readonly taskArtifacts?: TaskArtifactWriter,
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
    let taskArtifactIdForCleanup: string | null = null;
    let taskArtifactOwnerId: string | null = null;
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

      const resultProvenance = execution.agentResult.provenance ?? {};
      const externalReference = asTaskArtifactReference(resultProvenance.externalResultArtifact, taskId);
      let output: unknown = execution.agentResult.result;
      let taskResult: { output: unknown; provenance: Record<string, unknown> } = { output, provenance: resultProvenance };
      if (Buffer.byteLength(encodeJson(taskResult), 'utf8') > INLINE_RESULT_MAX_BYTES) {
        let artifact = externalReference;
        if (!artifact && this.taskArtifacts) {
          const body = Buffer.from(encodeJson(execution.agentResult.result), 'utf8');
          const stored = await this.taskArtifacts.storeJson({
            userId: task.userId,
            taskId,
            kind: 'TASK_RESULT',
            filename: 'task-output.json',
            body,
          });
          taskArtifactIdForCleanup = stored.artifactId;
          taskArtifactOwnerId = task.userId;
          artifact = { ...stored, downloadPath: `/v1/artifacts/${stored.artifactId}/content` };
        }
        if (!artifact) throw new HttpError(503, 'ARTIFACT_STORAGE_UNAVAILABLE', 'External result storage is required for this result but is not configured.');
        output = { artifact };
        taskResult = { output, provenance: resultProvenance };
      }
      if (Buffer.byteLength(encodeJson(taskResult), 'utf8') > INLINE_RESULT_MAX_BYTES) {
        throw new HttpError(503, 'ARTIFACT_STORAGE_UNAVAILABLE', 'The task result metadata exceeded the inline storage limit.');
      }
      if (!(await this.tasks.transitionTask(taskId, 'VERIFYING', 'COMPLETED', {
        result: taskResult,
        verification,
        leaseOwner,
      }))) return;
      taskArtifactIdForCleanup = null;
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
      if (taskArtifactIdForCleanup && taskArtifactOwnerId && this.taskArtifacts) {
        try {
          if (!(await this.taskArtifacts.deleteForOwner(taskArtifactIdForCleanup, taskArtifactOwnerId))) throw new Error('artifact not found');
        } catch {
          await this.tasks.appendTaskLog(taskId, 'ERROR', 'ARTIFACT_CLEANUP_FAILED: Unreferenced task artifact cleanup requires operator review.').catch(() => undefined);
          await this.audit.writeAudit({ actorUserId: null, action: 'TASK_ARTIFACT_CLEANUP_FAILED', resourceType: 'task', resourceId: taskId, details: { artifactId: taskArtifactIdForCleanup } }).catch(() => undefined);
        }
      }
      unsubscribeCancellation();
      clearInterval(heartbeat);
      await this.tasks.releaseTaskExecutionLease(taskId, leaseOwner).catch(() => undefined);
    }
  }
}
