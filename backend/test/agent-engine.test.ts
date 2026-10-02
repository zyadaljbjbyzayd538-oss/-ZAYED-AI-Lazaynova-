import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentEngine } from '../src/application/agent-engine.js';
import { CapabilityPlanner } from '../src/application/capability-planner.js';
import { DomainResultVerifier } from '../src/application/domain-result-verifier.js';
import type { Executor, ExecutionMonitor, Planner, TaskGraphRepository } from '../src/application/orchestration-ports.js';
import type { AgentPlan, TaskGraphSnapshot } from '../src/domain/task-graph.js';
import type { AgentExecutionContext, AgentResult } from '../src/domain/types.js';
import { HttpError } from '../src/domain/errors.js';

const context: AgentExecutionContext = {
  taskId: 'task-1', userId: 'owner', capability: 'WRITING', input: { text: 'Draft a welcome note', attachments: [] },
};
const output: AgentResult = {
  result: { text: 'Welcome.' },
  evidence: [{ kind: 'model_execution', provider: 'private', model: 'model-v1', modelVersion: 'model-v1', requestId: 'request-1', inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) }],
};

class Store implements TaskGraphRepository {
  snapshot: TaskGraphSnapshot | null = null;
  chain: AgentResult['evidence'] = [];
  async loadExecutionPlan(): Promise<TaskGraphSnapshot | null> { return this.snapshot ? structuredClone(this.snapshot) : null; }
  async saveExecutionPlan(_taskId: string, plan: AgentPlan, planHash: string): Promise<void> {
    this.snapshot = { plan, planHash, nodes: plan.graph.nodes.map((node) => ({ id: node.id, status: 'PENDING', attempts: 0, result: null })) };
  }
  async startGraphNode(): Promise<number | null> { return 1; }
  async completeGraphNode(): Promise<void> {}
  async failGraphNode(): Promise<void> {}
  async blockGraphNode(): Promise<boolean> { return false; }
  async persistEvidenceChain(_taskId: string, evidence: AgentResult['evidence']): Promise<void> { this.chain = evidence; }
}

const monitor: ExecutionMonitor = {
  async onTaskState() {},
  async onGraphNodeState() {},
};

test('AgentEngine retries a transient planner failure, persists the plan before execution, then chains/verifies the actual result', async () => {
  const basePlanner = new CapabilityPlanner();
  let planCalls = 0;
  const planner: Planner = {
    async isReady() { return true; },
    async plan(request) {
      planCalls += 1;
      if (planCalls < 3) throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'internal provider details');
      return basePlanner.plan(request);
    },
  };
  const store = new Store();
  let executionCalls = 0;
  const executor: Executor = { async execute(_context, snapshot) {
    assert.ok(store.snapshot);
    assert.equal(snapshot.plan.graph.nodes[0]?.id, 'run-writing');
    executionCalls += 1;
    return output;
  } };
  const engine = new AgentEngine(planner, executor, store, monitor, new DomainResultVerifier());
  const result = await engine.execute(context);
  assert.equal(planCalls, 3);
  assert.equal(executionCalls, 1);
  assert.equal(result.verification.passed, true);
  assert.equal(result.agentResult.evidence.at(-1)?.kind, 'evidence_chain');
  assert.deepEqual(store.chain, result.agentResult.evidence);
});

test('AgentEngine rejects a stored plan with an altered hash before executing a node', async () => {
  const planner = new CapabilityPlanner();
  const plan = await planner.plan(context);
  const store = new Store();
  await store.saveExecutionPlan('task-1', plan, 'f'.repeat(64));
  let executed = false;
  const executor: Executor = { async execute() { executed = true; return output; } };
  const engine = new AgentEngine(planner, executor, store, monitor, new DomainResultVerifier());
  await assert.rejects(() => engine.execute(context), (error: unknown) => error instanceof HttpError && error.code === 'TASK_PLAN_INTEGRITY_FAILED');
  assert.equal(executed, false);
});
