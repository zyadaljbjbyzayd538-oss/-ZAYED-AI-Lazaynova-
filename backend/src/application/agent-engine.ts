import { HttpError } from '../domain/errors.js';
import { buildEvidenceChain, verifyEvidenceChain } from '../domain/evidence-chain.js';
import { hashAgentPlan, validateTaskGraph } from '../domain/task-graph.js';
import type { AgentExecutionContext, AgentResult, TaskCapability, VerificationResult } from '../domain/types.js';
import type { Executor, ExecutionMonitor, Planner, ResultVerifier, TaskGraphRepository } from './orchestration-ports.js';
import { isRetryableUpstreamFailure, MAX_ATTEMPTS_PER_OPERATION, waitBeforeRetry } from './retry-policy.js';

export interface AgentEngineResult {
  agentResult: AgentResult;
  verification: VerificationResult;
  evidenceChainRoot: string;
}

/** Plans once, persists before execution, resumes completed nodes, then seals and verifies evidence. */
export class AgentEngine {
  constructor(
    private readonly planner: Planner,
    private readonly executor: Executor,
    private readonly graphRepository: TaskGraphRepository,
    private readonly monitor: ExecutionMonitor,
    private readonly verifier: ResultVerifier,
  ) {}

  isPlannerReady(): Promise<boolean> {
    return this.planner.isReady();
  }

  async execute(context: AgentExecutionContext): Promise<AgentEngineResult> {
    if (!context.taskId) throw new HttpError(400, 'TASK_ID_REQUIRED', 'A durable task id is required for agent execution.');

    if (context.capability === 'CHAT') throw new HttpError(400, 'TASK_CAPABILITY_REQUIRED', 'A task capability is required for agent execution.');
    const capability = context.capability as TaskCapability;

    let snapshot = await this.graphRepository.loadExecutionPlan(context.taskId);
    if (!snapshot) {
      const plan = await this.planWithRetry(context);
      validateTaskGraph(plan.graph, capability);
      const planHash = hashAgentPlan(plan);
      await this.graphRepository.saveExecutionPlan(context.taskId, plan, planHash);
      await this.monitor.onTaskState(context.taskId, 'PLANNING', 'plan_persisted');
      snapshot = await this.graphRepository.loadExecutionPlan(context.taskId);
    }

    if (!snapshot) throw new HttpError(503, 'TASK_PLAN_PERSISTENCE_FAILED', 'The execution plan could not be loaded after persistence.');
    const calculatedHash = hashAgentPlan(snapshot.plan);
    if (calculatedHash !== snapshot.planHash) throw new HttpError(503, 'TASK_PLAN_INTEGRITY_FAILED', 'The stored execution plan failed its integrity check.');
    validateTaskGraph(snapshot.plan.graph, capability);

    const rawResult = await this.executor.execute(context, snapshot);
    const chain = buildEvidenceChain([...snapshot.plan.plannerEvidence, ...rawResult.evidence]);
    if (!verifyEvidenceChain(chain.evidence)) throw new HttpError(502, 'EVIDENCE_CHAIN_INVALID', 'Execution evidence failed its integrity check.');

    const agentResult: AgentResult = {
      ...rawResult,
      evidence: chain.evidence,
      provenance: {
        ...(rawResult.provenance ?? {}),
        evidenceChainRoot: chain.rootHash,
        evidenceItemCount: chain.itemCount,
      },
    };
    const verified = await this.verifier.verify(context.capability, agentResult);
    const verification: VerificationResult = {
      passed: verified.passed && verifyEvidenceChain(verified.evidence),
      checkedAt: new Date().toISOString(),
      evidence: verified.evidence,
      issues: verifyEvidenceChain(verified.evidence) ? verified.issues : [...verified.issues, 'EVIDENCE_CHAIN_INTEGRITY_FAILED'],
    };
    await this.graphRepository.persistEvidenceChain(context.taskId, chain.evidence);
    return { agentResult, verification, evidenceChainRoot: chain.rootHash };
  }

  private async planWithRetry(context: AgentExecutionContext) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_OPERATION; attempt += 1) {
      try {
        return await this.planner.plan(context);
      } catch (error) {
        if (!isRetryableUpstreamFailure(error) || attempt === MAX_ATTEMPTS_PER_OPERATION) throw error;
        await waitBeforeRetry(Math.min(2_000, 250 * (2 ** (attempt - 1))), context.signal);
      }
    }
    throw new HttpError(503, 'TASK_PLANNER_FAILED', 'The task planner could not complete this request.');
  }
}
