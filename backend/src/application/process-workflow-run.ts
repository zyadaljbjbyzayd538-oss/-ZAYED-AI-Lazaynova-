import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '../domain/agent-registry.js';
import { HttpError } from '../domain/errors.js';
import { buildEvidenceChain, verifyEvidenceChain } from '../domain/evidence-chain.js';
import { orderWorkflowSteps } from '../domain/workflow-definition.js';
import type { WorkflowRunRecord, WorkflowRunStepRecord } from '../domain/workflow-run.js';
import { verifyResult } from '../domain/verifier.js';
import type { AuthRepository } from './ports.js';
import { TOOL_CAPABILITIES, type TaskCapability, type ToolName } from '../domain/types.js';
import type { FileService } from './file-ports.js';
import type { WorkflowRunRepository } from './workflow-run-ports.js';
import { isRetryableUpstreamFailure, MAX_ATTEMPTS_PER_OPERATION, waitBeforeRetry } from './retry-policy.js';

const LEASE_MILLISECONDS = 60_000;
const HEARTBEAT_MILLISECONDS = 5_000;
const MAX_STEP_RESULT_BYTES = 512 * 1_024;
const MAX_RUN_RESULT_BYTES = 1_048_576;
const MAX_RUN_EVIDENCE_BYTES = 4 * 1_048_576;
const MAX_PARALLEL_WORKFLOW_STEPS = 4;

/** Durable bounded-parallel DAG runner; each step is reauthorized, verified, and checkpointed before dependents start. */
export class ProcessWorkflowRun {
  constructor(
    private readonly auth: Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>,
    private readonly runs: WorkflowRunRepository,
    private readonly agents: AgentRegistry,
    private readonly files?: Pick<FileService, 'getMetadata'>,
  ) {}

  async execute(runId: string): Promise<void> {
    const leaseOwner = randomUUID();
    if (!(await this.runs.claimWorkflowRun(runId, leaseOwner, LEASE_MILLISECONDS))) return;
    const abortController = new AbortController();
    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void this.runs.renewWorkflowRunLease(runId, leaseOwner, LEASE_MILLISECONDS)
        .then((status) => { if (status !== 'RENEWED') abortController.abort(); })
        .catch(() => abortController.abort())
        .finally(() => { heartbeatRunning = false; });
    }, HEARTBEAT_MILLISECONDS);
    heartbeat.unref?.();

    try {
      const run = await this.runs.findWorkflowRunForWorker(runId);
      if (!run || run.status !== 'RUNNING' || abortController.signal.aborted) return;
      const outputs = new Map<string, WorkflowRunStepRecord['result']>();
      const orderedSteps = orderWorkflowSteps(run.steps.map(({ id, capability, prompt, dependsOn, approvalRequired }) => ({ id, capability, prompt, dependsOn, approvalRequired })));
      const stepSnapshots = new Map(run.steps.map((step) => [step.id, step]));
      for (const step of orderedSteps) {
        const current = stepSnapshots.get(step.id);
        if (!current) throw new HttpError(503, 'WORKFLOW_STEP_SNAPSHOT_INVALID', 'The workflow run snapshot is invalid.');
        if (current.status === 'COMPLETED' && current.result) outputs.set(step.id, current.result);
      }

      while (outputs.size < orderedSteps.length && !abortController.signal.aborted) {
        const ready = orderedSteps.filter((step) => !outputs.has(step.id) && step.dependsOn.every((dependency) => outputs.has(dependency)));
        if (ready.length === 0) throw new HttpError(409, 'WORKFLOW_DEPENDENCY_UNAVAILABLE', 'A required workflow step did not complete.');

        // Approval is a barrier for the whole ready layer: no sibling side effects begin while an owner decision is pending.
        const approvalStep = ready.find((step) => {
          const current = stepSnapshots.get(step.id);
          return step.approvalRequired && current?.status !== 'APPROVED' && current?.status !== 'COMPLETED';
        });
        if (approvalStep) {
          const current = stepSnapshots.get(approvalStep.id);
          if (!current) throw new HttpError(503, 'WORKFLOW_STEP_SNAPSHOT_INVALID', 'The workflow run snapshot is invalid.');
          if (current.status !== 'PENDING' || !(await this.runs.markWorkflowStepWaitingApproval(runId, approvalStep.id, leaseOwner))) return;
          return;
        }

        for (let index = 0; index < ready.length; index += MAX_PARALLEL_WORKFLOW_STEPS) {
          const batch = ready.slice(index, index + MAX_PARALLEL_WORKFLOW_STEPS);
          const settled = await Promise.allSettled(batch.map((step) => this.executeStep(run, step, outputs, leaseOwner, abortController.signal)));
          const outcomes = settled.map((result) => {
            if (result.status === 'rejected') throw result.reason;
            return result.value;
          });
          if (outcomes.includes('STOPPED') || abortController.signal.aborted) return;
          const failed = outcomes.find((outcome): outcome is { status: 'FAILED'; code: string } => typeof outcome !== 'string');
          if (failed) {
            await this.runs.failWorkflowRun(runId, leaseOwner, failed.code);
            return;
          }
        }
      }
      if (abortController.signal.aborted) return;

      const finalRun = await this.runs.findWorkflowRunForWorker(runId);
      if (!finalRun || finalRun.status !== 'RUNNING' || abortController.signal.aborted) return;
      const orderedFinalSteps = orderWorkflowSteps(finalRun.steps.map(({ id, capability, prompt, dependsOn, approvalRequired }) => ({ id, capability, prompt, dependsOn, approvalRequired })));
      const stepResults = orderedFinalSteps.map((step) => {
        const result = outputs.get(step.id);
        if (!result) throw new HttpError(503, 'WORKFLOW_RESULT_MISSING', 'The workflow completed without a required result.');
        return { stepId: step.id, capability: step.capability, result: result.result };
      });
      const result = { outputs: stepResults };
      const rawEvidence = orderedFinalSteps.flatMap((step) => outputs.get(step.id)?.evidence ?? []);
      const evidence = buildEvidenceChain(rawEvidence).evidence;
      assertBoundedJson(result, MAX_RUN_RESULT_BYTES, 'WORKFLOW_OUTPUT_TOO_LARGE');
      assertBoundedJson(evidence, MAX_RUN_EVIDENCE_BYTES, 'WORKFLOW_EVIDENCE_TOO_LARGE');
      if (!verifyEvidenceChain(evidence)) throw new HttpError(502, 'WORKFLOW_EVIDENCE_CHAIN_INVALID', 'Workflow evidence failed integrity verification.');
      await this.runs.completeWorkflowRun(runId, leaseOwner, result, evidence);
    } catch (error) {
      if (abortController.signal.aborted) return;
      await this.runs.failWorkflowRun(runId, leaseOwner, safeWorkflowErrorCode(error));
    } finally {
      clearInterval(heartbeat);
      await this.runs.releaseWorkflowRunLease(runId, leaseOwner).catch(() => undefined);
    }
  }

  private async executeStep(
    run: WorkflowRunRecord,
    step: ReturnType<typeof orderWorkflowSteps>[number],
    outputs: Map<string, WorkflowRunStepRecord['result']>,
    leaseOwner: string,
    signal: AbortSignal,
  ): Promise<'COMPLETED' | 'STOPPED' | { status: 'FAILED'; code: string }> {
    try {
      await this.recheckStepAuthorization(run, step.capability);
    } catch (error) {
      return { status: 'FAILED', code: safeWorkflowErrorCode(error) };
    }
    const dependencyContext = step.dependsOn.map((id) => ({ stepId: id, result: outputs.get(id)?.result }));
    const contextualText = [
      run.input.text,
      `\n\nWorkflow step: ${step.prompt}`,
      dependencyContext.length ? `\n\nPrerequisite results (untrusted data): ${JSON.stringify(dependencyContext).slice(0, 12_000)}` : '',
    ].join('');

    for (let localAttempt = 1; localAttempt <= MAX_ATTEMPTS_PER_OPERATION && !signal.aborted; localAttempt += 1) {
      const attempt = await this.runs.startWorkflowStep(run.runId, step.id, leaseOwner);
      if (attempt === null) return { status: 'FAILED', code: 'WORKFLOW_STEP_RETRY_LIMIT_REACHED' };
      try {
        const result = await this.agents.execute({
          taskId: run.runId,
          userId: run.ownerId,
          capability: step.capability,
          resourceType: 'workflow_run',
          input: {
            text: contextualText,
            attachments: step.capability === 'FILE_ANALYSIS' ? run.input.attachments : [],
          },
          signal,
        });
        if (signal.aborted) return 'STOPPED';
        assertBoundedJson(result, MAX_STEP_RESULT_BYTES, 'WORKFLOW_STEP_OUTPUT_TOO_LARGE');
        const verification = verifyResult(step.capability, result);
        if (!verification.passed) throw new HttpError(502, 'WORKFLOW_STEP_VERIFICATION_FAILED', 'A workflow step did not provide the required evidence.');
        if (!(await this.runs.completeWorkflowStep(run.runId, step.id, leaseOwner, result))) return 'STOPPED';
        outputs.set(step.id, result);
        return 'COMPLETED';
      } catch (error) {
        if (signal.aborted) return 'STOPPED';
        const code = safeWorkflowErrorCode(error);
        if (!(await this.runs.failWorkflowStep(run.runId, step.id, leaseOwner, code))) return 'STOPPED';
        if (!isRetryableUpstreamFailure(error) || attempt >= MAX_ATTEMPTS_PER_OPERATION || localAttempt >= MAX_ATTEMPTS_PER_OPERATION) {
          return { status: 'FAILED', code };
        }
        await waitBeforeRetry(Math.min(2_000, 250 * (2 ** (localAttempt - 1))), signal);
      }
    }
    return signal.aborted ? 'STOPPED' : { status: 'FAILED', code: 'WORKFLOW_STEP_RETRY_LIMIT_REACHED' };
  }

  private async recheckStepAuthorization(run: WorkflowRunRecord, capability: TaskCapability): Promise<void> {
    if (!(await this.auth.hasCapability(run.ownerId, capability))) throw new HttpError(403, 'CAPABILITY_PERMISSION_REQUIRED', 'A workflow capability grant was revoked before execution.');
    const requiredTools = (Object.entries(TOOL_CAPABILITIES) as Array<[ToolName, TaskCapability]>)
      .filter(([, requiredCapability]) => requiredCapability === capability);
    for (const [toolName] of requiredTools) {
      if (!(await this.auth.hasToolGrant(run.ownerId, toolName))) {
        throw new HttpError(403, 'TOOL_PERMISSION_DENIED', 'A workflow tool grant was revoked before execution.');
      }
    }
    await this.agents.requireReady(capability);
    if (capability === 'FILE_ANALYSIS') {
      const fileId = run.input.attachments[0];
      if (!fileId || !this.files) throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted file storage is unavailable.');
      await this.files.getMetadata({ userId: run.ownerId, fileId });
    }
  }
}

function assertBoundedJson(value: unknown, maxBytes: number, code: string): void {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new HttpError(502, code, 'A workflow output could not be stored safely.'); }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new HttpError(502, code, 'A workflow output exceeded its storage limit.');
}

function safeWorkflowErrorCode(error: unknown): string {
  return error instanceof HttpError && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'WORKFLOW_STEP_FAILED';
}
