import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import { HttpError } from '../src/domain/errors.js';
import { DagExecutor } from '../src/application/dag-executor.js';
import type { ExecutionMonitor, TaskGraphRepository } from '../src/application/orchestration-ports.js';
import type { AgentPlan, GraphNodeStatus, TaskGraphSnapshot } from '../src/domain/task-graph.js';
import type { AgentExecutionContext, AgentResult } from '../src/domain/types.js';

const plan: AgentPlan = {
  graph: {
    version: 1,
    rootCapability: 'WRITING',
    nodes: [
      { id: 'final', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'Polish the result', dependsOn: ['draft'] },
      { id: 'draft', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'Create a draft', dependsOn: [] },
    ],
  },
  plannerEvidence: [],
  plannerProvenance: { planner: 'test' },
};

class Store implements TaskGraphRepository {
  snapshot: TaskGraphSnapshot = {
    plan,
    planHash: 'a'.repeat(64),
    nodes: plan.graph.nodes.map((node) => ({ id: node.id, status: 'PENDING', attempts: 0, result: null })),
  };
  async loadExecutionPlan(): Promise<TaskGraphSnapshot> { return structuredClone(this.snapshot); }
  async saveExecutionPlan(): Promise<void> {}
  async startGraphNode(_taskId: string, id: string): Promise<number | null> {
    const node = this.snapshot.nodes.find((item) => item.id === id);
    if (!node || node.attempts >= 3 || node.status === 'COMPLETED') return null;
    node.status = 'RUNNING';
    node.attempts += 1;
    return node.attempts;
  }
  async completeGraphNode(_taskId: string, id: string, result: AgentResult): Promise<void> {
    const node = this.snapshot.nodes.find((item) => item.id === id)!;
    node.status = 'COMPLETED';
    node.result = result;
  }
  async failGraphNode(_taskId: string, id: string): Promise<void> {
    this.snapshot.nodes.find((item) => item.id === id)!.status = 'FAILED';
  }
  async blockGraphNode(_taskId: string, id: string): Promise<boolean> {
    const node = this.snapshot.nodes.find((item) => item.id === id);
    if (!node || node.status !== 'PENDING') return false;
    node.status = 'BLOCKED';
    return true;
  }
  async persistEvidenceChain(): Promise<void> {}
}

class Monitor implements ExecutionMonitor {
  nodeEvents: Array<{ id: string; status: GraphNodeStatus; attempt?: number }> = [];
  async onTaskState(): Promise<void> {}
  async onGraphNodeState(_taskId: string, id: string, status: GraphNodeStatus, attempt?: number): Promise<void> {
    this.nodeEvents.push({ id, status, ...(attempt === undefined ? {} : { attempt }) });
  }
}

const context: AgentExecutionContext = {
  taskId: 'task-1', userId: 'owner', capability: 'WRITING', input: { text: 'Write this', attachments: [] },
};

function driver(run: (context: AgentExecutionContext) => Promise<AgentResult>): CapabilityDriver {
  return { capability: 'WRITING', async isReady() { return true; }, execute: run };
}

test('DAG executor runs topologically, injects only prerequisite output context, and aggregates evidence', async () => {
  const store = new Store();
  const monitor = new Monitor();
  const seen: string[] = [];
  const agents = new AgentRegistry();
  agents.register(driver(async (runContext) => {
    seen.push(runContext.input.text);
    const label = seen.length === 1 ? 'draft-output' : 'final-output';
    return { result: { text: label }, evidence: [{ kind: 'stage', label }] };
  }));
  const executor = new DagExecutor(agents, store, monitor, async () => {});
  const result = await executor.execute(context, store.snapshot);
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /Planned subtask: Create a draft/);
  assert.match(seen[1]!, /draft-output/);
  assert.deepEqual((result.result as { text: string }).text, 'final-output');
  assert.equal(result.evidence.length, 2);
  assert.deepEqual(monitor.nodeEvents.filter((event) => event.status === 'COMPLETED').map((event) => event.id), ['draft', 'final']);
});

test('DAG executor retries only allowlisted transient upstream errors and persists attempt states', async () => {
  const store = new Store();
  const monitor = new Monitor();
  let calls = 0;
  const agents = new AgentRegistry();
  agents.register(driver(async () => {
    calls += 1;
    if (calls === 1) throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'private upstream details');
    return { result: { text: 'draft' }, evidence: [{ kind: 'test' }] };
  }));
  const result = await new DagExecutor(agents, store, monitor, async () => {}).execute(context, store.snapshot);
  assert.equal(calls, 3);
  assert.equal((result.result as { text: string }).text, 'draft');
  assert.deepEqual(monitor.nodeEvents.filter((event) => event.id === 'draft').map((event) => event.status), ['RUNNING', 'FAILED', 'RUNNING', 'COMPLETED']);
  assert.equal(store.snapshot.nodes.find((node) => node.id === 'draft')?.attempts, 2);
});

test('DAG executor resumes a completed checkpoint without repeating its provider call', async () => {
  const store = new Store();
  const completed: AgentResult = { result: { text: 'persisted draft' }, evidence: [{ kind: 'stage', label: 'cached' }] };
  store.snapshot.nodes.find((node) => node.id === 'draft')!.status = 'COMPLETED';
  store.snapshot.nodes.find((node) => node.id === 'draft')!.result = completed;
  let calls = 0;
  const agents = new AgentRegistry();
  agents.register(driver(async (runContext) => {
    calls += 1;
    assert.match(runContext.input.text, /persisted draft/);
    return { result: { text: 'recovered final' }, evidence: [{ kind: 'stage', label: 'final' }] };
  }));
  const result = await new DagExecutor(agents, store, new Monitor(), async () => {}).execute(context, store.snapshot);
  assert.equal(calls, 1);
  assert.deepEqual((result.result as { text: string }).text, 'recovered final');
});
