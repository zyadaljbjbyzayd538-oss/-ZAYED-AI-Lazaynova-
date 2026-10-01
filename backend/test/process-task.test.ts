import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessTask } from '../src/application/process-task.js';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import { HttpError } from '../src/domain/errors.js';
import type { AuthRepository, TaskRepository, AuditRepository } from '../src/application/ports.js';
import { hashAgentPlan, type AgentPlan, type GraphNodeStatus, type TaskGraphSnapshot } from '../src/domain/task-graph.js';
import { CapabilityPlanner } from '../src/application/capability-planner.js';
import type { AgentResult, TaskRecord, TaskStatus, VerificationResult } from '../src/domain/types.js';

const queuedTask: TaskRecord = {
  id: 'task-1', userId: 'user-1', type: 'WEB_RESEARCH', status: 'QUEUED', priority: 0,
  createdAt: '2026-09-29T00:00:00.000Z', startedAt: null, completedAt: null,
  input: { text: 'ابحث عن مصادر', attachments: [] }, steps: [], logs: [], result: null, error: null, verification: null,
};
class FakeTasks {
  status: TaskStatus = 'QUEUED';
  transitions: Array<[TaskStatus, TaskStatus]> = [];
  error: { code: string; message: string } | undefined;
  verification: VerificationResult | undefined;
  plan: AgentPlan | null = null;
  planHash = '';
  nodes = new Map<string, { status: GraphNodeStatus; attempts: number; result: AgentResult | null }>();
  evidenceChain: AgentResult['evidence'] = [];
  async claimTaskExecution(): Promise<boolean> {
    if (this.status === 'COMPLETED' || this.status === 'FAILED' || this.status === 'CANCELLED') return false;
    this.status = 'PLANNING';
    return true;
  }
  async renewTaskExecutionLease(): Promise<boolean> { return true; }
  async releaseTaskExecutionLease(): Promise<void> {}
  async findTaskForWorker(): Promise<TaskRecord> { return { ...queuedTask, status: this.status }; }
  async findTaskExecutionState(): Promise<{ userId: string; status: TaskStatus }> { return { userId: queuedTask.userId, status: this.status }; }
  async transitionTask(_id: string, from: TaskStatus, to: TaskStatus, details?: { error?: { code: string; message: string }; result?: unknown; verification?: VerificationResult }): Promise<boolean> {
    if (this.status !== from) return false;
    this.status = to;
    this.transitions.push([from, to]);
    this.error = details?.error;
    this.verification = details?.verification;
    return true;
  }
  async appendTaskLog(): Promise<void> {}
  async loadExecutionPlan(): Promise<TaskGraphSnapshot | null> {
    if (!this.plan) return null;
    return { plan: this.plan, planHash: this.planHash, nodes: [...this.nodes].map(([id, node]) => ({ id, ...node })) };
  }
  async saveExecutionPlan(_taskId: string, plan: AgentPlan, planHash: string): Promise<void> {
    this.plan = plan;
    this.planHash = planHash;
    for (const node of plan.graph.nodes) this.nodes.set(node.id, { status: 'PENDING', attempts: 0, result: null });
  }
  async startGraphNode(_taskId: string, nodeId: string): Promise<number | null> {
    const node = this.nodes.get(nodeId);
    if (!node || node.attempts >= 3 || node.status === 'COMPLETED') return null;
    node.attempts += 1;
    node.status = 'RUNNING';
    return node.attempts;
  }
  async completeGraphNode(_taskId: string, nodeId: string, result: AgentResult): Promise<void> {
    const node = this.nodes.get(nodeId)!;
    node.status = 'COMPLETED';
    node.result = result;
  }
  async failGraphNode(_taskId: string, nodeId: string): Promise<void> {
    this.nodes.get(nodeId)!.status = 'FAILED';
  }
  async blockGraphNode(_taskId: string, nodeId: string): Promise<boolean> {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== 'PENDING') return false;
    node.status = 'BLOCKED';
    return true;
  }
  async persistEvidenceChain(_taskId: string, evidence: AgentResult['evidence']): Promise<void> { this.evidenceChain = evidence; }
}
const noAudit: AuditRepository = { async writeAudit() {} };
const makeDriver = (run: () => AgentResult): CapabilityDriver => ({
  capability: 'WEB_RESEARCH',
  async isReady() { return true; },
  async execute() { return run(); },
});

test('worker re-checks revoked permission and fails without calling agent', async () => {
  let executed = false;
  const tasks = new FakeTasks();
  const agents = new AgentRegistry(); agents.register(makeDriver(() => { executed = true; return { result: {}, evidence: [] }; }));
  const auth = { async hasCapability() { return false; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(executed, false);
  assert.equal(tasks.status, 'FAILED');
  assert.equal(tasks.error?.code, 'CAPABILITY_PERMISSION_REQUIRED');
});

test('worker fails closed if engine is no longer ready', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry(); agents.register({ ...makeDriver(() => ({ result: {}, evidence: [] })), async isReady() { return false; } });
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.status, 'FAILED');
  assert.equal(tasks.error?.code, 'CAPABILITY_UNAVAILABLE');
});

test('worker preserves allowlisted provider errors but never persists provider internals', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(makeDriver(() => { throw new HttpError(503, 'RESEARCH_PROVIDER_REQUEST_FAILED', 'secret upstream response body'); }));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.status, 'FAILED');
  assert.equal(tasks.error?.code, 'RESEARCH_PROVIDER_REQUEST_FAILED');
  assert.equal(tasks.error?.message, 'The configured research provider could not complete this task.');
  assert.equal(tasks.error?.message.includes('secret upstream response body'), false);
});

test('worker surfaces durable usage-accounting failures safely and does not retry the provider call', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(makeDriver(() => { throw new HttpError(503, 'AI_USAGE_ACCOUNTING_FAILED', 'database detail'); }));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.status, 'FAILED');
  assert.equal(tasks.error?.code, 'AI_USAGE_ACCOUNTING_FAILED');
  assert.equal(tasks.error?.message, 'Provider usage could not be recorded; the provider result was withheld.');
  assert.equal(tasks.error?.message.includes('database detail'), false);
  assert.equal(tasks.nodes.get('run-web_research')?.attempts, 1);
});

test('worker reports file integrity failures without persisting cryptographic or storage details', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(makeDriver(() => { throw new HttpError(503, 'FILE_INTEGRITY_CHECK_FAILED', 'secret storage diagnostic'); }));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.error?.code, 'FILE_INTEGRITY_CHECK_FAILED');
  assert.equal(tasks.error?.message, 'Stored file integrity verification failed.');
  assert.equal(tasks.error?.message.includes('secret storage diagnostic'), false);
});

test('worker records verification evidence failure instead of completing unsupported output', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry(); agents.register(makeDriver(() => ({ result: { text: 'Draft' }, evidence: [] })));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.status, 'FAILED');
  assert.equal(tasks.error?.code, 'VERIFICATION_EVIDENCE_REQUIRED');
  assert.equal(tasks.verification?.passed, false);
});

test('worker recovers an expired lease and resumes a completed durable graph node without repeating inference', async () => {
  const tasks = new FakeTasks();
  tasks.status = 'RUNNING';
  const planner = new CapabilityPlanner();
  tasks.plan = await planner.plan({ taskId: 'task-1', userId: 'user-1', capability: 'WEB_RESEARCH', input: queuedTask.input });
  tasks.planHash = hashAgentPlan(tasks.plan);
  tasks.nodes.set('run-web_research', {
    status: 'COMPLETED',
    attempts: 1,
    result: {
      result: { text: 'Recovered summary' },
      evidence: [
        { kind: 'source', url: 'https://example.com/source', title: 'Source', excerpt: 'Supporting evidence.' },
        { kind: 'research_capture', urls: ['https://example.com/source'], fetched_at: '2026-09-29T00:00:00.000Z', raw_source_hash: 'a'.repeat(64) },
      ],
    },
  });
  let repeated = false;
  const agents = new AgentRegistry(); agents.register(makeDriver(() => { repeated = true; throw new Error('must resume from checkpoint'); }));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(repeated, false);
  assert.equal(tasks.status, 'COMPLETED');
  assert.deepEqual(tasks.transitions, [['PLANNING', 'RUNNING'], ['RUNNING', 'VERIFYING'], ['VERIFYING', 'COMPLETED']]);
});

test('worker aborts provider execution immediately when an owner cancellation event arrives', async () => {
  const tasks = new FakeTasks();
  let executed = false;
  let unsubscribed = false;
  const agents = new AgentRegistry();
  agents.register({
    capability: 'WEB_RESEARCH',
    async isReady() { return true; },
    async execute(context) {
      executed = true;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new HttpError(409, 'TASK_EXECUTION_CANCELLED', 'cancelled'));
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) abort();
      });
    },
  });
  const taskEvents = {
    subscribe(taskId: string, userId: string, listener: (event: { taskId: string; userId: string; status: TaskStatus; changedAt: string }) => void) {
      const timer = setTimeout(() => {
        tasks.status = 'CANCELLED';
        listener({ taskId, userId, status: 'CANCELLED', changedAt: '2026-09-30T00:00:00.000Z' });
      }, 10);
      return () => { clearTimeout(timer); unsubscribed = true; };
    },
  };
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  const running = new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents, undefined, taskEvents).execute('task-1');
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([running, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('provider execution did not receive cancellation')), 1_000);
    })]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  assert.equal(executed, true);
  assert.equal(tasks.status, 'CANCELLED');
  assert.equal(tasks.transitions.some(([, to]) => to === 'FAILED' || to === 'COMPLETED'), false);
  assert.equal(unsubscribed, true);
});

test('worker persists a one-node plan and evidence chain before completing after verification', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry(); agents.register(makeDriver(() => ({
    result: { text: 'Research summary' },
    evidence: [
      { kind: 'source', url: 'https://example.com/source', title: 'Source', excerpt: 'Supporting evidence.' },
      { kind: 'research_capture', urls: ['https://example.com/source'], fetched_at: '2026-09-29T00:00:00.000Z', raw_source_hash: 'a'.repeat(64) },
    ],
  })));
  const auth = { async hasCapability() { return true; } } as unknown as AuthRepository;
  await new ProcessTask(auth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
  assert.equal(tasks.status, 'COMPLETED');
  assert.deepEqual(tasks.transitions, [['PLANNING', 'RUNNING'], ['RUNNING', 'VERIFYING'], ['VERIFYING', 'COMPLETED']]);
  assert.equal(tasks.plan?.graph.nodes.length, 1);
  assert.equal(tasks.nodes.get('run-web_research')?.status, 'COMPLETED');
  assert.equal(tasks.verification?.passed, true);
  assert.equal(tasks.evidenceChain.at(-1)?.kind, 'evidence_chain');
});
