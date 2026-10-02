import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import { WorkflowDefinitionService } from '../src/application/workflow-definition-service.js';
import type { WorkflowDefinitionRepository } from '../src/application/workflow-definition-ports.js';
import { WorkflowRunService } from '../src/application/workflow-run-service.js';
import { ProcessWorkflowRun } from '../src/application/process-workflow-run.js';
import type { WorkflowRunRepository } from '../src/application/workflow-run-ports.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import { HttpError } from '../src/domain/errors.js';
import { verifyEvidenceChain } from '../src/domain/evidence-chain.js';
import type { WorkflowDefinitionInput, WorkflowDefinitionVersion } from '../src/domain/workflow-definition.js';
import type { WorkflowApprovalDecision, WorkflowRunCreateRecord, WorkflowRunRecord, WorkflowRunStepRecord } from '../src/domain/workflow-run.js';
import type { AgentResult, AuthenticatedUser, EvidenceItem } from '../src/domain/types.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';

const owner: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'owner@example.test', role: 'USER', sessionId: 'owner-session' };
const otherId = '3512c44b-8119-488e-85c0-d1b035f6857f';
const workflowId = '4412c44b-8119-488e-85c0-d1b035f6857f';
const headers = { authorization: `Bearer ${'o'.repeat(40)}` };
const otherHeaders = { authorization: `Bearer ${'x'.repeat(40)}` };
const at = '2026-09-30T00:00:00.000Z';
const researchEvidence: EvidenceItem[] = [
  { kind: 'source', number: 1, title: 'Primary source', url: 'https://example.test/source', excerpt: 'A useful finding.' },
  { kind: 'research_capture', urls: ['https://example.test/source'], fetched_at: at, raw_source_hash: 'a'.repeat(64) },
];

class MemoryDefinitions implements WorkflowDefinitionRepository {
  private stored: WorkflowDefinitionVersion | null = null;
  async createWorkflowDefinition(_ownerId: string, definition: WorkflowDefinitionInput) {
    this.stored = { workflowId, name: definition.name, version: 1, steps: definition.steps, createdAt: at };
    return this.stored;
  }
  async createWorkflowDefinitionVersion(ownerId: string, id: string, definition: { steps: WorkflowDefinitionInput['steps'] }) {
    if (ownerId !== owner.id || id !== workflowId || !this.stored) return null;
    this.stored = { ...this.stored, version: this.stored.version + 1, steps: definition.steps, createdAt: at };
    return this.stored;
  }
  async listWorkflowDefinitions() { return this.stored ? [{ workflowId, name: this.stored.name, latestVersion: this.stored.version, createdAt: at, updatedAt: at }] : []; }
  async findWorkflowDefinitionVersion(ownerId: string, id: string, version: number) {
    return ownerId === owner.id && id === workflowId && this.stored?.version === version ? this.stored : null;
  }
  async findLatestWorkflowDefinition(ownerId: string, id: string) {
    return ownerId === owner.id && id === workflowId ? this.stored : null;
  }
}

class MemoryRuns implements WorkflowRunRepository {
  readonly records = new Map<string, WorkflowRunRecord>();
  readonly actions: string[] = [];
  lease: string | null = null;
  acceptedOutbox = 0;
  async createWorkflowRun(input: WorkflowRunCreateRecord): Promise<WorkflowRunRecord> {
    const run: WorkflowRunRecord = {
      runId: randomUUID(), ownerId: input.ownerId, workflowId: input.workflowId,
      workflowName: input.workflowName, version: input.version, status: 'QUEUED', input: structuredClone(input.input),
      steps: input.steps.map((step) => ({ ...structuredClone(step), status: 'PENDING', attempts: 0, result: null, errorCode: null, approvedBy: null, approvedAt: null })),
      result: null, evidence: null, errorCode: null, cancelRequested: false, createdAt: at, startedAt: null, completedAt: null,
    };
    this.records.set(run.runId, run);
    this.actions.push('WORKFLOW_RUN_ACCEPTED');
    this.acceptedOutbox += 1;
    return structuredClone(run);
  }
  async findWorkflowRun(runId: string, ownerId: string) { const r = this.records.get(runId); return r?.ownerId === ownerId ? structuredClone(r) : null; }
  async findWorkflowRunForWorker(runId: string) { const r = this.records.get(runId); return r ? structuredClone(r) : null; }
  async claimWorkflowRun(runId: string, leaseOwner: string) {
    const r = this.records.get(runId);
    if (!r || !['QUEUED', 'RUNNING'].includes(r.status) || this.lease) return false;
    this.lease = leaseOwner; r.status = 'RUNNING'; r.startedAt ??= at; return true;
  }
  async renewWorkflowRunLease(runId: string, leaseOwner: string) {
    const r = this.records.get(runId);
    if (r?.status === 'CANCELLED') return 'CANCELLED' as const;
    return r?.status === 'RUNNING' && this.lease === leaseOwner ? 'RENEWED' as const : 'LOST' as const;
  }
  async releaseWorkflowRunLease(_runId: string, leaseOwner: string) { if (this.lease === leaseOwner) this.lease = null; }
  async markWorkflowStepWaitingApproval(runId: string, stepId: string, leaseOwner: string) {
    const r = this.records.get(runId); const s = r?.steps.find((item) => item.id === stepId);
    if (!r || !s || r.status !== 'RUNNING' || this.lease !== leaseOwner || s.status !== 'PENDING') return false;
    s.status = 'WAITING_APPROVAL'; r.status = 'WAITING_APPROVAL'; this.actions.push('WORKFLOW_APPROVAL_REQUIRED'); this.lease = null; return true;
  }
  async startWorkflowStep(runId: string, stepId: string, leaseOwner: string) {
    const r = this.records.get(runId); const s = r?.steps.find((item) => item.id === stepId);
    if (!r || !s || r.status !== 'RUNNING' || this.lease !== leaseOwner || !['PENDING', 'APPROVED', 'FAILED', 'RUNNING'].includes(s.status) || s.attempts >= 3) return null;
    s.status = 'RUNNING'; s.attempts += 1; return s.attempts;
  }
  async completeWorkflowStep(runId: string, stepId: string, leaseOwner: string, result: AgentResult) {
    const r = this.records.get(runId); const s = r?.steps.find((item) => item.id === stepId);
    if (!r || !s || r.status !== 'RUNNING' || this.lease !== leaseOwner || s.status !== 'RUNNING') return false;
    s.status = 'COMPLETED'; s.result = structuredClone(result); s.errorCode = null; this.actions.push('WORKFLOW_STEP_COMPLETED'); return true;
  }
  async failWorkflowStep(runId: string, stepId: string, leaseOwner: string, code: string) {
    const r = this.records.get(runId); const s = r?.steps.find((item) => item.id === stepId);
    if (!r || !s || r.status !== 'RUNNING' || this.lease !== leaseOwner || s.status !== 'RUNNING') return false;
    s.status = 'FAILED'; s.errorCode = code; this.actions.push('WORKFLOW_STEP_FAILED'); return true;
  }
  async blockPendingWorkflowSteps(runId: string, leaseOwner: string) {
    const r = this.records.get(runId); if (!r || r.status !== 'RUNNING' || this.lease !== leaseOwner) return;
    for (const s of r.steps) if (['PENDING', 'APPROVED'].includes(s.status)) s.status = 'BLOCKED';
  }
  async completeWorkflowRun(runId: string, leaseOwner: string, result: WorkflowRunRecord['result'], evidence: EvidenceItem[]) {
    const r = this.records.get(runId); if (!r || r.status !== 'RUNNING' || this.lease !== leaseOwner) return false;
    r.status = 'COMPLETED'; r.result = structuredClone(result); r.evidence = structuredClone(evidence); r.completedAt = at; this.actions.push('WORKFLOW_RUN_COMPLETED'); this.lease = null; return true;
  }
  async failWorkflowRun(runId: string, leaseOwner: string, code: string) {
    const r = this.records.get(runId); if (!r || r.status !== 'RUNNING' || this.lease !== leaseOwner) return false;
    r.status = 'FAILED'; r.errorCode = code; r.completedAt = at; this.actions.push('WORKFLOW_RUN_FAILED'); this.lease = null;
    for (const s of r.steps) if (['PENDING', 'APPROVED'].includes(s.status)) s.status = 'BLOCKED';
    return true;
  }
  async decideWorkflowApproval(ownerId: string, runId: string, stepId: string, decision: WorkflowApprovalDecision) {
    const r = this.records.get(runId);
    if (!r || r.ownerId !== ownerId) return 'NOT_FOUND' as const;
    const s = r.steps.find((item) => item.id === stepId);
    if (r.status !== 'WAITING_APPROVAL' || !s || s.status !== 'WAITING_APPROVAL') return 'NOT_WAITING' as const;
    s.approvedBy = ownerId; s.approvedAt = at;
    if (decision === 'APPROVE') { s.status = 'APPROVED'; r.status = 'QUEUED'; this.actions.push('WORKFLOW_STEP_APPROVED'); this.acceptedOutbox += 1; return 'APPROVED' as const; }
    s.status = 'REJECTED'; s.errorCode = 'WORKFLOW_APPROVAL_REJECTED'; r.status = 'FAILED'; r.errorCode = s.errorCode; r.completedAt = at; this.actions.push('WORKFLOW_STEP_REJECTED');
    for (const pending of r.steps) if (['PENDING', 'APPROVED'].includes(pending.status)) pending.status = 'BLOCKED';
    return 'REJECTED' as const;
  }
  async cancelWorkflowRun(ownerId: string, runId: string) {
    const r = this.records.get(runId);
    if (!r || r.ownerId !== ownerId) return 'NOT_FOUND' as const;
    if (r.status === 'CANCELLED') return 'ALREADY_CANCELLED' as const;
    if (!['QUEUED', 'RUNNING', 'WAITING_APPROVAL'].includes(r.status)) return 'NOT_CANCELLABLE' as const;
    r.status = 'CANCELLED'; r.cancelRequested = true; r.completedAt = at; this.actions.push('WORKFLOW_RUN_CANCELLED'); this.lease = null;
    for (const s of r.steps) if (['PENDING', 'APPROVED', 'WAITING_APPROVAL'].includes(s.status)) s.status = 'BLOCKED';
    return 'CANCELLED' as const;
  }
}

function makeAgentRegistry(calls: string[], transientFailures = 0) {
  const registry = new AgentRegistry();
  registry.register({
    capability: 'WEB_RESEARCH',
    async isReady() { return true; },
    async execute(context) {
      calls.push(`research:${context.input.text}`);
      if (transientFailures > 0) { transientFailures -= 1; throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'safe'); }
      return { result: { text: 'Finding [1].' }, evidence: researchEvidence, provenance: { requestId: 'research-1' } };
    },
  });
  registry.register({
    capability: 'WRITING',
    async isReady() { return true; },
    async execute(context) {
      calls.push(`writing:${context.input.text}`);
      return { result: { text: 'A grounded summary.' }, evidence: [{ kind: 'model_execution', requestId: 'writing-1' }] };
    },
  });
  return registry;
}

function noopAudit(actions: string[]): AuditRepository {
  return { async writeAudit(input) { actions.push(input.action); } };
}

test('workflow run snapshots a definition, waits for required owner approval, resumes and verifies dependency results', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, {
    name: 'approval-flow',
    steps: [
      { id: 'research', capability: 'WEB_RESEARCH', prompt: 'Find sources.', dependsOn: [], approvalRequired: true },
      { id: 'summary', capability: 'WRITING', prompt: 'Summarize findings.', dependsOn: ['research'], approvalRequired: false },
    ],
  });
  const runs = new MemoryRuns();
  const calls: string[] = [];
  const agents = makeAgentRegistry(calls, 2);
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, auth, agents, { async isToolReady() { return true; } });
  const accepted = await service.start(owner.id, workflowId, { prompt: 'Research this topic.' });
  assert.equal(accepted.status, 'QUEUED');
  assert.equal(accepted.steps[0]?.status, 'PENDING');
  assert.equal(JSON.stringify(accepted).includes('Research this topic.'), false);
  assert.equal(runs.acceptedOutbox, 1);

  const processor = new ProcessWorkflowRun(auth, runs, agents);
  await processor.execute(accepted.runId);
  let current = await service.get(owner.id, accepted.runId);
  assert.equal(current.status, 'WAITING_APPROVAL');
  assert.equal(current.steps[0]?.status, 'WAITING_APPROVAL');
  assert.equal(calls.length, 0);

  current = await service.decide(owner.id, accepted.runId, 'research', 'APPROVE');
  assert.equal(current.status, 'QUEUED');
  assert.equal(current.steps[0]?.status, 'APPROVED');
  await processor.execute(accepted.runId);

  current = await service.get(owner.id, accepted.runId);
  assert.equal(current.status, 'COMPLETED');
  assert.equal(current.steps[0]?.attempts, 3);
  assert.equal(current.steps[0]?.status, 'COMPLETED');
  assert.equal(current.steps[1]?.status, 'COMPLETED');
  assert.match(calls.find((call) => call.startsWith('writing:')) ?? '', /Finding \[1\]/);
  assert.equal(current.result?.outputs.length, 2);
  assert.equal(verifyEvidenceChain(runs.records.get(accepted.runId)?.evidence ?? []), true);
  assert.ok(runs.actions.includes('WORKFLOW_STEP_APPROVED'));
});

test('workflow runner gates a ready layer on owner approval, then runs independent steps concurrently before dependents', async () => {
  const runs = new MemoryRuns();
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const agents = new AgentRegistry();
  let activeRoots = 0;
  let peakRoots = 0;
  let rootStarts = 0;
  let releaseRoots: (() => void) | undefined;
  const bothRootsStarted = new Promise<void>((resolve) => { releaseRoots = resolve; });
  const observedInputs: string[] = [];
  agents.register({
    capability: 'WRITING',
    async isReady() { return true; },
    async execute(context) {
      const text = context.input.text;
      observedInputs.push(text);
      if (text.includes('Workflow step: Combine both outputs.')) {
        assert.match(text, /source-a/);
        assert.match(text, /source-b/);
        return { result: { text: 'Combined.' }, evidence: [] };
      }
      activeRoots += 1;
      rootStarts += 1;
      peakRoots = Math.max(peakRoots, activeRoots);
      if (rootStarts === 2) releaseRoots?.();
      await bothRootsStarted;
      activeRoots -= 1;
      return { result: { text: text.includes('source A') ? 'A ready.' : 'B ready.' }, evidence: [] };
    },
  });
  // Create the definition and run service with the same in-memory repository.
  const definitionRepository = new MemoryDefinitions();
  const definitionService = new WorkflowDefinitionService(definitionRepository);
  await definitionService.create(owner.id, { name: 'parallel-flow', steps: [
    { id: 'source-a', capability: 'WRITING', prompt: 'Create source A.', dependsOn: [], approvalRequired: true },
    { id: 'source-b', capability: 'WRITING', prompt: 'Create source B.', dependsOn: [], approvalRequired: false },
    { id: 'combine', capability: 'WRITING', prompt: 'Combine both outputs.', dependsOn: ['source-a', 'source-b'], approvalRequired: false },
  ] });
  const workflowService = new WorkflowRunService(definitionService, runs, auth, agents);
  const accepted = await workflowService.start(owner.id, workflowId, { prompt: 'Produce three outputs.' });
  const processor = new ProcessWorkflowRun(auth, runs, agents);
  await processor.execute(accepted.runId);
  assert.equal((await workflowService.get(owner.id, accepted.runId)).status, 'WAITING_APPROVAL');
  assert.equal(observedInputs.length, 0, 'approval gate must block all side effects in its ready layer');

  await workflowService.decide(owner.id, accepted.runId, 'source-a', 'APPROVE');
  await processor.execute(accepted.runId);
  const completed = await workflowService.get(owner.id, accepted.runId);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(peakRoots, 2);
  assert.equal(completed.steps.every((step) => step.status === 'COMPLETED'), true);
  assert.match(observedInputs.at(-1) ?? '', /\"stepId\":\"source-a\"/);
  assert.match(observedInputs.at(-1) ?? '', /\"stepId\":\"source-b\"/);
  assert.equal(runs.records.get(accepted.runId)?.steps.length, 3);
});

test('workflow run preflight requires every capability and its separate tool grant before creating an outbox record', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, { name: 'approval-flow', steps: [
    { id: 'research', capability: 'WEB_RESEARCH', prompt: 'Search.', dependsOn: [], approvalRequired: false },
  ] });
  const runs = new MemoryRuns();
  const agents = makeAgentRegistry([]);
  const noToolGrant = {
    async hasCapability() { return true; },
    async hasToolGrant() { return false; },
  } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, noToolGrant, agents, { async isToolReady() { return true; } });
  await assert.rejects(() => service.start(owner.id, workflowId, { prompt: 'Search this.' }),
    (error: unknown) => error instanceof HttpError && error.code === 'TOOL_PERMISSION_DENIED');
  assert.equal(runs.acceptedOutbox, 0);
});

test('workflow approval is owner-scoped, and rejection fails the run without executing its step', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, { name: 'approval-flow', steps: [
    { id: 'draft', capability: 'WRITING', prompt: 'Draft.', dependsOn: [], approvalRequired: true },
  ] });
  const runs = new MemoryRuns(); const calls: string[] = [];
  const agents = makeAgentRegistry(calls);
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, auth, agents, { async isToolReady() { return true; } });
  const accepted = await service.start(owner.id, workflowId, { prompt: 'Do it.' });
  await new ProcessWorkflowRun(auth, runs, agents).execute(accepted.runId);
  await assert.rejects(() => service.decide(otherId, accepted.runId, 'draft', 'REJECT'),
    (error: unknown) => error instanceof HttpError && error.code === 'WORKFLOW_RUN_NOT_FOUND');
  const rejected = await service.decide(owner.id, accepted.runId, 'draft', 'REJECT');
  assert.equal(rejected.status, 'FAILED');
  assert.equal(rejected.errorCode, 'WORKFLOW_APPROVAL_REJECTED');
  assert.equal(calls.length, 0);
});

test('workflow run rechecks separate tool grants after queue acceptance and fails before calling a revoked tool', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, { name: 'approval-flow', steps: [
    { id: 'research', capability: 'WEB_RESEARCH', prompt: 'Search.', dependsOn: [], approvalRequired: false },
  ] });
  const runs = new MemoryRuns(); const calls: string[] = []; let toolGrant = true;
  const agents = makeAgentRegistry(calls);
  const auth = {
    async hasCapability() { return true; },
    async hasToolGrant() { return toolGrant; },
  } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, auth, agents, { async isToolReady() { return true; } });
  const accepted = await service.start(owner.id, workflowId, { prompt: 'Search this.' });
  toolGrant = false;
  await new ProcessWorkflowRun(auth, runs, agents).execute(accepted.runId);
  const failed = await service.get(owner.id, accepted.runId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'TOOL_PERMISSION_DENIED');
  assert.equal(calls.length, 0);
});

test('owner cancellation is terminal and prevents queued workflow steps from executing', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, { name: 'approval-flow', steps: [
    { id: 'draft', capability: 'WRITING', prompt: 'Draft.', dependsOn: [], approvalRequired: false },
  ] });
  const runs = new MemoryRuns(); const calls: string[] = []; const agents = makeAgentRegistry(calls);
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, auth, agents);
  const accepted = await service.start(owner.id, workflowId, { prompt: 'Draft.' });
  const cancelled = await service.cancel(owner.id, accepted.runId);
  assert.equal(cancelled.status, 'CANCELLED');
  await new ProcessWorkflowRun(auth, runs, agents).execute(accepted.runId);
  assert.equal(calls.length, 0);
});

test('workflow run HTTP endpoints require authentication, isolate owners, and expose no prompts', async () => {
  const definitions = new WorkflowDefinitionService(new MemoryDefinitions());
  await definitions.create(owner.id, { name: 'approval-flow', steps: [
    { id: 'draft', capability: 'WRITING', prompt: 'Private step prompt.', dependsOn: [], approvalRequired: true }
  ] });
  const runs = new MemoryRuns(); const agents = makeAgentRegistry([]);
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>;
  const service = new WorkflowRunService(definitions, runs, auth, agents);
  const app = await buildApp({
    sessions: { async authenticate(token: string) { return token === 'o'.repeat(40) ? owner : { ...owner, id: otherId }; } } as unknown as SessionService,
    auth: {} as AuthRepository, tasks: {} as TaskRepository, audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest, agents, workflows: definitions, workflowRuns: service, logger: false,
  });
  try {
    const unauthenticated = await app.inject({ method: 'POST', url: `/v1/workflows/${workflowId}/runs`, payload: { prompt: 'Secret user prompt.' } });
    assert.equal(unauthenticated.statusCode, 401);
    const accepted = await app.inject({ method: 'POST', url: `/v1/workflows/${workflowId}/runs`, headers, payload: { prompt: 'Secret user prompt.' } });
    assert.equal(accepted.statusCode, 202);
    assert.equal(JSON.stringify(accepted.json()).includes('Secret user prompt.'), false);
    assert.equal(JSON.stringify(accepted.json()).includes('Private step prompt.'), false);
    const runId = accepted.json().runId as string;
    await new ProcessWorkflowRun(auth, runs, agents).execute(runId);
    const ownRead = await app.inject({ method: 'GET', url: `/v1/workflow-runs/${runId}`, headers });
    assert.equal(ownRead.statusCode, 200);
    assert.equal(ownRead.json().status, 'WAITING_APPROVAL');
    const otherRead = await app.inject({ method: 'GET', url: `/v1/workflow-runs/${runId}`, headers: otherHeaders });
    assert.equal(otherRead.statusCode, 404);
    assert.equal(otherRead.json().error.code, 'WORKFLOW_RUN_NOT_FOUND');
    const otherApproval = await app.inject({
      method: 'POST', url: `/v1/workflow-runs/${runId}/steps/draft/approval`, headers: otherHeaders, payload: { decision: 'APPROVE' },
    });
    assert.equal(otherApproval.statusCode, 404);
    const approved = await app.inject({
      method: 'POST', url: `/v1/workflow-runs/${runId}/steps/draft/approval`, headers, payload: { decision: 'APPROVE' },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().status, 'QUEUED');
    const cancelled = await app.inject({ method: 'POST', url: `/v1/workflow-runs/${runId}/cancel`, headers });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, 'CANCELLED');
    const progress = await app.inject({ method: 'GET', url: `/v1/workflow-runs/${runId}/stream`, headers });
    assert.equal(progress.statusCode, 200);
    assert.match(progress.headers['content-type'] ?? '', /text\/event-stream/);
    assert.match(progress.body, /event: progress/);
    assert.match(progress.body, /CANCELLED/);
    assert.equal(progress.body.includes('Private step prompt.'), false);
    const otherProgress = await app.inject({ method: 'GET', url: `/v1/workflow-runs/${runId}/stream`, headers: otherHeaders });
    assert.equal(otherProgress.statusCode, 404);
  } finally { await app.close(); }
});
