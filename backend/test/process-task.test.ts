import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessTask } from '../src/application/process-task.js';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import { HttpError } from '../src/domain/errors.js';
import { hashAgentPlan, type AgentPlan, type GraphNodeStatus, type TaskGraphSnapshot } from '../src/domain/task-graph.js';
import { CapabilityPlanner } from '../src/application/capability-planner.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { AgentResult, TaskRecord, TaskStatus, VerificationResult } from '../src/domain/types.js';
import type { TaskArtifactMetadata, TaskArtifactWriter } from '../src/application/artifact-ports.js';
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
    result: unknown;
    rejectCompletion = false;
    plan: AgentPlan | null = null;
    planHash = '';
    nodes = new Map<string, { status: GraphNodeStatus; attempts: number; result: AgentResult | null }>();
    evidenceChain: AgentResult['evidence'] = [];
    async claimTaskExecution() {
        if (this.status === 'COMPLETED' || this.status === 'FAILED' || this.status === 'CANCELLED')
            return false;
        this.status = 'PLANNING';
        return true;
    }
    async renewTaskExecutionLease() { return true; }
    async releaseTaskExecutionLease() { }
    async findTaskForWorker() { return { ...queuedTask, status: this.status }; }
    async findTaskExecutionState() { return { userId: queuedTask.userId, status: this.status }; }
    async transitionTask(_id: string, from: TaskStatus, to: TaskStatus, details?: { error?: { code: string; message: string }; result?: unknown; verification?: VerificationResult }) {
        if (to === 'COMPLETED' && this.rejectCompletion) { this.status = 'CANCELLED'; return false; }
        if (this.status !== from)
            return false;
        this.status = to;
        this.transitions.push([from, to]);
        this.error = details?.error;
        this.verification = details?.verification;
        this.result = details?.result;
        return true;
    }
    async appendTaskLog() { }
    async loadExecutionPlan() {
        if (!this.plan)
            return null;
        return { plan: this.plan, planHash: this.planHash, nodes: [...this.nodes].map(([id, node]) => ({ id, ...node })) };
    }
    async saveExecutionPlan(_taskId: string, plan: AgentPlan, planHash: string) {
        this.plan = plan;
        this.planHash = planHash;
        for (const node of plan.graph.nodes)
            this.nodes.set(node.id, { status: 'PENDING', attempts: 0, result: null });
    }
    async startGraphNode(_taskId: string, nodeId: string): Promise<number | null> {
        const node = this.nodes.get(nodeId);
        if (!node || node.attempts >= 3 || node.status === 'COMPLETED')
            return null;
        node.attempts += 1;
        node.status = 'RUNNING';
        return node.attempts;
    }
    async completeGraphNode(_taskId: string, nodeId: string, result: AgentResult): Promise<void> {
        const node = this.nodes.get(nodeId);
        if (!node) throw new Error('graph node is missing');
        node.status = 'COMPLETED';
        node.result = result;
    }
    async failGraphNode(_taskId: string, nodeId: string): Promise<void> { this.nodes.get(nodeId)!.status = 'FAILED'; }
    async blockGraphNode(_taskId: string, nodeId: string): Promise<boolean> {
        const node = this.nodes.get(nodeId);
        if (!node || node.status !== 'PENDING')
            return false;
        node.status = 'BLOCKED';
        return true;
    }
    async persistEvidenceChain(_taskId: string, evidence: AgentResult['evidence']): Promise<void> { this.evidenceChain = evidence; }
}
const noAudit: AuditRepository = { async writeAudit() { } };
const makeDriver = (run: () => AgentResult): CapabilityDriver => ({
    capability: 'WEB_RESEARCH',
    async isReady() { return true; },
    async execute() { return run(); },
});
const validResearch = (text = 'Research summary'): AgentResult => ({
    result: { text },
    evidence: [
        { kind: 'source', url: 'https://example.com/source', title: 'Source', excerpt: 'Supporting evidence.' },
        { kind: 'research_capture', urls: ['https://example.com/source'], fetched_at: '2026-09-29T00:00:00.000Z', raw_source_hash: 'a'.repeat(64) },
    ],
});
const allowAuth = { async hasCapability() { return true; } } as unknown as AuthRepository;
test('worker re-checks revoked permission and fails without calling agent', async () => {
    let executed = false;
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => { executed = true; return { result: {}, evidence: [] }; }));
    const auth = { async hasCapability() { return false; } };
    await new ProcessTask(auth as unknown as AuthRepository, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
    assert.equal(executed, false);
    assert.equal(tasks.status, 'FAILED');
    assert.equal(tasks.error?.code, 'CAPABILITY_PERMISSION_REQUIRED');
});
test('worker fails closed if engine is no longer ready', async () => {
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register({ ...makeDriver(() => ({ result: {}, evidence: [] })), async isReady() { return false; } });
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
    assert.equal(tasks.status, 'FAILED');
    assert.equal(tasks.error?.code, 'CAPABILITY_UNAVAILABLE');
});
test('worker preserves allowlisted provider errors but never persists provider internals', async () => {
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => { throw new HttpError(503, 'RESEARCH_PROVIDER_REQUEST_FAILED', 'secret upstream response body'); }));
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
    assert.equal(tasks.status, 'FAILED');
    assert.equal(tasks.error?.code, 'RESEARCH_PROVIDER_REQUEST_FAILED');
    assert.equal(tasks.error?.message, 'The configured research provider could not complete this task.');
    assert.equal(tasks.error?.message.includes('secret upstream response body'), false);
});
test('worker surfaces durable usage-accounting failures safely and does not retry the provider call', async () => {
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => { throw new HttpError(503, 'AI_USAGE_ACCOUNTING_FAILED', 'database detail'); }));
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
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
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
    assert.equal(tasks.error?.code, 'FILE_INTEGRITY_CHECK_FAILED');
    assert.equal(tasks.error?.message, 'Stored file integrity verification failed.');
    assert.equal(tasks.error?.message.includes('secret storage diagnostic'), false);
});
test('worker records verification evidence failure instead of completing unsupported output', async () => {
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => ({ result: { text: 'Draft' }, evidence: [] })));
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
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
    tasks.nodes.set('run-web_research', { status: 'COMPLETED', attempts: 1, result: validResearch('Recovered summary') });
    let repeated = false;
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => { repeated = true; throw new Error('must resume from checkpoint'); }));
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
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
                if (context.signal?.aborted)
                    abort();
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
    const running = new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents, undefined, taskEvents).execute('task-1');
    let timeout;
    try {
        await Promise.race([running, new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error('provider execution did not receive cancellation')), 1_000);
            })]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
    assert.equal(executed, true);
    assert.equal(tasks.status, 'CANCELLED');
    assert.equal(tasks.transitions.some(([, to]) => to === 'FAILED' || to === 'COMPLETED'), false);
    assert.equal(unsubscribed, true);
});
test('worker persists a one-node plan and evidence chain before completing after verification', async () => {
    const tasks = new FakeTasks();
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => validResearch()));
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents).execute('task-1');
    assert.equal(tasks.status, 'COMPLETED');
    assert.deepEqual(tasks.transitions, [['PLANNING', 'RUNNING'], ['RUNNING', 'VERIFYING'], ['VERIFYING', 'COMPLETED']]);
    assert.equal(tasks.plan?.graph.nodes.length, 1);
    assert.equal(tasks.nodes.get('run-web_research')?.status, 'COMPLETED');
    assert.equal(tasks.verification?.passed, true);
    assert.equal(tasks.evidenceChain.at(-1)?.kind, 'evidence_chain');
});
test('worker externalizes an oversized task output and stores only an owner-scoped artifact reference inline', async () => {
    const tasks = new FakeTasks();
    const largeText = 'actual generated research output '.repeat(4_000);
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => validResearch(largeText)));
    const metadata = {
        artifactId: '9e82df6f-f302-4a5b-a68a-54641af6945a', taskId: 'task-1', kind: 'TASK_RESULT',
        filename: 'task-output.json', contentType: 'application/json', byteLength: Buffer.byteLength(JSON.stringify({ text: largeText })),
        sha256: 'a'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z',
    };
    let storedBody: Buffer | undefined;
    let deleted = false;
    const artifacts = {
        async isReady() { return true; },
        async storeJson(input: Parameters<TaskArtifactWriter['storeJson']>[0]) { storedBody = Buffer.from(input.body); return metadata; },
        async readForOwner() { return { metadata, body: storedBody ?? Buffer.alloc(0) }; },
        async deleteForOwner() { deleted = true; return true; },
    };
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents, undefined, undefined, artifacts as TaskArtifactWriter).execute('task-1');
    assert.equal(tasks.status, 'COMPLETED');
    assert.ok(storedBody && storedBody.byteLength > 64 * 1_024);
    assert.equal(JSON.parse(storedBody.toString('utf8')).text, largeText);
    const taskResult = tasks.result as { output: unknown; provenance: Record<string, unknown> };
    assert.deepEqual(taskResult.output, {
        artifact: { ...metadata, downloadPath: `/v1/artifacts/${metadata.artifactId}/content` },
    });
    assert.equal(typeof taskResult.provenance.evidenceChainRoot, 'string');
    assert.equal(deleted, false);
});

test('worker cleans newly stored bytes when task completion loses a cancellation race', async () => {
    const tasks = new FakeTasks();
    tasks.rejectCompletion = true;
    const largeText = 'result '.repeat(10_000);
    const agents = new AgentRegistry();
    agents.register(makeDriver(() => validResearch(largeText)));
    const metadata: TaskArtifactMetadata = {
        artifactId: 'cf554a42-8a29-49cd-9ea0-8abb18c4f7f5', taskId: 'task-1', kind: 'TASK_RESULT',
        filename: 'task-output.json', contentType: 'application/json', byteLength: Buffer.byteLength(JSON.stringify({ text: largeText })),
        sha256: 'b'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z',
    };
    let deletedFor: string | undefined;
    const artifacts: TaskArtifactWriter = {
        async isReady() { return true; },
        async storeJson() { return metadata; },
        async readForOwner() { return { metadata, body: Buffer.alloc(metadata.byteLength) }; },
        async deleteForOwner(_id, userId) { deletedFor = userId; return true; },
    };
    await new ProcessTask(allowAuth, tasks as unknown as TaskRepository, noAudit, agents, undefined, undefined, artifacts).execute('task-1');
    assert.equal(tasks.status, 'CANCELLED');
    assert.equal(deletedFor, queuedTask.userId);
});