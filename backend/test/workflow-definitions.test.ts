import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import type { WorkflowDefinitionRepository } from '../src/application/workflow-definition-ports.js';
import { WorkflowDefinitionService } from '../src/application/workflow-definition-service.js';
import {
  workflowDefinitionInputSchema,
  workflowVersionInputSchema,
  orderWorkflowSteps,
  type WorkflowDefinitionInput,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionVersion,
} from '../src/domain/workflow-definition.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { SessionService } from '../src/auth/session-service.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthenticatedUser } from '../src/domain/types.js';

const owner: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'owner@example.test', role: 'USER', sessionId: 'owner-session' };
const other: AuthenticatedUser = { id: '3512c44b-8119-488e-85c0-d1b035f6857f', email: 'other@example.test', role: 'USER', sessionId: 'other-session' };
const workflowId = '4412c44b-8119-488e-85c0-d1b035f6857f';
const headers = { authorization: `Bearer ${'o'.repeat(40)}` };
const otherHeaders = { authorization: `Bearer ${'x'.repeat(40)}` };
const at = '2026-09-30T00:00:00.000Z';

function makeMemoryRepository(): WorkflowDefinitionRepository {
  const definitions = new Map<string, { ownerId: string; name: string; versions: WorkflowDefinitionVersion[] }>();
  const newVersion = (workflowId: string, name: string, version: number, steps: WorkflowDefinitionInput['steps']): WorkflowDefinitionVersion => ({
    workflowId, name, version, steps, createdAt: at,
  });
  return {
    async createWorkflowDefinition(ownerId, definition) {
      const item = newVersion(workflowId, definition.name, 1, definition.steps);
      definitions.set(workflowId, { ownerId, name: definition.name, versions: [item] });
      return item;
    },
    async createWorkflowDefinitionVersion(ownerId, id, definition) {
      const stored = definitions.get(id);
      if (!stored || stored.ownerId !== ownerId) return null;
      const item = newVersion(id, stored.name, stored.versions.length + 1, definition.steps);
      stored.versions.push(item);
      return item;
    },
    async listWorkflowDefinitions(ownerId): Promise<WorkflowDefinitionSummary[]> {
      return [...definitions.entries()].filter(([, stored]) => stored.ownerId === ownerId).map(([id, stored]) => ({
        workflowId: id, name: stored.name, latestVersion: stored.versions.length, createdAt: at, updatedAt: at,
      }));
    },
    async findWorkflowDefinitionVersion(ownerId, id, version) {
      const stored = definitions.get(id);
      return stored?.ownerId === ownerId ? stored.versions.find((item) => item.version === version) ?? null : null;
    },
    async findLatestWorkflowDefinition(ownerId, id) {
      const stored = definitions.get(id);
      return stored?.ownerId === ownerId ? stored.versions.at(-1) ?? null : null;
    },
  };
}

function makeApp(workflows = new WorkflowDefinitionService(makeMemoryRepository())) {
  return buildApp({
    sessions: { async authenticate(token: string) { return token === 'o'.repeat(40) ? owner : other; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    workflows,
    logger: false,
  });
}

const firstVersion = {
  name: 'weekly-research',
  steps: [
    { id: 'research', capability: 'WEB_RESEARCH', prompt: 'Find recent primary sources.', dependsOn: [], approvalRequired: true },
    { id: 'summary', capability: 'WRITING', prompt: 'Summarize the approved findings.', dependsOn: ['research'], approvalRequired: false },
  ],
};

test('workflow definitions enforce a bounded DAG, known capabilities, strict fields, and explicit approval metadata', () => {
  const parsed = workflowDefinitionInputSchema.parse(firstVersion);
  assert.deepEqual(orderWorkflowSteps(parsed.steps).map((step) => step.id), ['research', 'summary']);
  assert.equal(workflowVersionInputSchema.safeParse({ steps: [{ ...firstVersion.steps[0], shell: 'echo unsafe' }] }).success, false);
  assert.equal(workflowDefinitionInputSchema.safeParse({ ...firstVersion, steps: [{ ...firstVersion.steps[0], capability: 'CODING' }] }).success, false);
  assert.equal(workflowDefinitionInputSchema.safeParse({ ...firstVersion, steps: [
    { ...firstVersion.steps[0], dependsOn: ['summary'] }, firstVersion.steps[1],
  ] }).success, false);
  assert.equal(workflowDefinitionInputSchema.safeParse({ ...firstVersion, steps: [firstVersion.steps[0], { ...firstVersion.steps[1], dependsOn: ['missing'] }] }).success, false);
  assert.equal(workflowDefinitionInputSchema.safeParse({ ...firstVersion, steps: Array.from({ length: 13 }, (_, index) => ({ ...firstVersion.steps[0], id: `step-${index}` })) }).success, false);
});

test('workflow HTTP API creates append-only versions, lists owner-scoped definitions, and fetches historical versions', async () => {
  const app = await makeApp();
  try {
    const unauthenticated = await app.inject({ method: 'POST', url: '/v1/workflows', payload: firstVersion });
    assert.equal(unauthenticated.statusCode, 401);
    const created = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: firstVersion });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().version, 1);
    assert.equal(created.json().steps.length, 2);

    const list = await app.inject({ method: 'GET', url: '/v1/workflows', headers });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().workflows.map((item: { latestVersion: number }) => item.latestVersion), [1]);

    const versionTwo = await app.inject({
      method: 'POST', url: `/v1/workflows/${workflowId}/versions`, headers,
      payload: { steps: [{ id: 'draft', capability: 'WRITING', prompt: 'Write a draft.', dependsOn: [], approvalRequired: true }] },
    });
    assert.equal(versionTwo.statusCode, 201);
    assert.equal(versionTwo.json().version, 2);

    const historical = await app.inject({ method: 'GET', url: `/v1/workflows/${workflowId}/versions/1`, headers });
    assert.equal(historical.statusCode, 200);
    assert.equal(historical.json().steps[0].id, 'research');

    const latest = await app.inject({ method: 'GET', url: `/v1/workflows/${workflowId}`, headers });
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.json().version, 2);
    assert.equal(latest.json().steps[0].id, 'draft');

    const isolated = await app.inject({ method: 'GET', url: `/v1/workflows/${workflowId}`, headers: otherHeaders });
    assert.equal(isolated.statusCode, 404);
    assert.equal(isolated.json().error.code, 'WORKFLOW_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('workflow HTTP API rejects invalid graphs and malformed IDs without persisting them', async () => {
  let createCalls = 0;
  const repository = makeMemoryRepository();
  const service = new WorkflowDefinitionService({
    ...repository,
    async createWorkflowDefinition(ownerId: string, definition: WorkflowDefinitionInput) {
      createCalls += 1;
      return repository.createWorkflowDefinition(ownerId, definition);
    },
  });
  const app = await makeApp(service);
  try {
    const invalid = await app.inject({ method: 'POST', url: '/v1/workflows', headers, payload: {
      name: 'unsafe', steps: [{ ...firstVersion.steps[0], dependsOn: ['missing'] }],
    } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_REQUEST');
    assert.equal(createCalls, 0);

    const malformedId = await app.inject({ method: 'GET', url: '/v1/workflows/not-a-uuid', headers });
    assert.equal(malformedId.statusCode, 400);
    assert.equal(malformedId.json().error.code, 'INVALID_WORKFLOW_ID');

    const malformedVersion = await app.inject({ method: 'GET', url: `/v1/workflows/${workflowId}/versions/0`, headers });
    assert.equal(malformedVersion.statusCode, 400);
    assert.equal(malformedVersion.json().error.code, 'INVALID_WORKFLOW_VERSION');
  } finally {
    await app.close();
  }
});

test('workflow endpoints fail closed when durable definition storage is unavailable', async () => {
  const app = await buildApp({
    sessions: { async authenticate() { return owner; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    logger: false,
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/workflows', headers });
    assert.equal(response.statusCode, 501);
    assert.equal(response.json().error.code, 'WORKFLOW_STORE_UNAVAILABLE');
  } finally {
    await app.close();
  }
});
