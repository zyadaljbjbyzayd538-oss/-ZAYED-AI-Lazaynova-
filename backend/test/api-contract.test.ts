import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import { CapabilityPermissionError, CapabilityUnavailableError } from '../src/domain/errors.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { AuthenticatedUser, TaskRecord } from '../src/domain/types.js';
import type { TaskEventSource, TaskStatusEvent } from '../src/application/task-events.js';

const user: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'user@example.test', role: 'USER', sessionId: 'session-1' };
const auth = {
  async hasCapability() { return false; },
  async findUserByEmail() { return null; },
} as unknown as AuthRepository;
const tasks = { async findTask() { return null; } } as unknown as TaskRepository;
const audit = { async writeAudit() {} } as AuditRepository;
const headers = { authorization: `Bearer ${'t'.repeat(40)}` };

async function makeApp(
  execute: () => Promise<never>,
  submitCapability: SubmitAssistantRequest['submitCapability'] = async () => { throw new Error('unexpected task execution'); },
) {
  return buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth,
    tasks,
    audit,
    submit: { async execute() { return execute(); }, submitCapability } as unknown as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    rateLimit: { max: 100, timeWindow: '1 minute' },
    logger: false,
  });
}

test('assistant HTTP boundary rejects unauthenticated requests', async () => {
  const app = await makeApp(async () => { throw new Error('must not run'); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/assistant/requests', payload: { input: 'hello' } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  } finally {
    await app.close();
  }
});

test('assistant HTTP boundary validates input before submitting', async () => {
  const app = await makeApp(async () => { throw new Error('must not run'); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/assistant/requests', headers, payload: { input: '  ' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  } finally {
    await app.close();
  }
});

test('permission failure is surfaced synchronously as HTTP 403 with stable code', async () => {
  const app = await makeApp(async () => { throw new CapabilityPermissionError(); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/assistant/requests', headers, payload: { input: 'اكتب رسالة' } });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'CAPABILITY_PERMISSION_REQUIRED');
  } finally {
    await app.close();
  }
});

test('engine readiness failure is surfaced synchronously as HTTP 501 with stable code', async () => {
  const app = await makeApp(async () => { throw new CapabilityUnavailableError(); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/assistant/requests', headers, payload: { input: 'ابحث عن مصادر' } });
    assert.equal(response.statusCode, 501);
    assert.equal(response.json().error.code, 'CAPABILITY_UNAVAILABLE');
  } finally {
    await app.close();
  }
});

test('explicit task endpoint forwards authenticated identity, capability, prompt and params', async () => {
  let observed: { userId: string; capability: string; input: unknown } | null = null;
  const app = await makeApp(async () => { throw new Error('wrong endpoint'); }, async (authenticatedUser, capability, input) => {
    observed = { userId: authenticatedUser.id, capability, input };
    return { kind: 'TASK', taskId: 'task-1', status: 'QUEUED', createdAt: '2026-09-29T00:00:00.000Z', type: capability };
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/tasks/execute', headers,
      payload: { capability: 'MODEL_ANALYSIS', prompt: 'Analyze the model output', params: { modelId: 'model-7' } },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().type, 'MODEL_ANALYSIS');
    assert.deepEqual(observed, {
      userId: user.id,
      capability: 'MODEL_ANALYSIS',
      input: { text: 'Analyze the model output', params: { modelId: 'model-7' } },
    });
  } finally {
    await app.close();
  }
});

test('explicit task endpoint rejects CHAT so it cannot be accidentally queued', async () => {
  const app = await makeApp(async () => { throw new Error('wrong endpoint'); });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/tasks/execute', headers, payload: { capability: 'CHAT', prompt: 'Hello' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  } finally {
    await app.close();
  }
});

test('task cancellation is authenticated, owner-scoped, idempotent, and rejects terminal tasks', async () => {
  const taskId = '3512c44b-8119-488e-85c0-d1b035f6857f';
  let result: 'CANCELLED' | 'ALREADY_CANCELLED' | 'NOT_FOUND' | 'NOT_CANCELLABLE' = 'CANCELLED';
  let observed: { taskId: string; userId: string } | null = null;
  const app = await buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth,
    tasks: { async cancelTask(id: string, userId: string) { observed = { taskId: id, userId }; return result; } } as unknown as TaskRepository,
    audit,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    logger: false,
  });
  try {
    const cancelled = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/cancel`, headers });
    assert.equal(cancelled.statusCode, 200);
    assert.deepEqual(cancelled.json(), { taskId, status: 'CANCELLED' });
    assert.deepEqual(observed, { taskId, userId: user.id });

    result = 'ALREADY_CANCELLED';
    const repeated = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/cancel`, headers });
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().status, 'CANCELLED');

    result = 'NOT_CANCELLABLE';
    const finished = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/cancel`, headers });
    assert.equal(finished.statusCode, 409);
    assert.equal(finished.json().error.code, 'TASK_NOT_CANCELLABLE');

    result = 'NOT_FOUND';
    const notOwned = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/cancel`, headers });
    assert.equal(notOwned.statusCode, 404);
    assert.equal(notOwned.json().error.code, 'TASK_NOT_FOUND');

    const invalidId = await app.inject({ method: 'POST', url: '/v1/tasks/not-a-uuid/cancel', headers });
    assert.equal(invalidId.statusCode, 400);
    assert.equal(invalidId.json().error.code, 'INVALID_TASK_ID');
  } finally {
    await app.close();
  }
});

test('WebSocket task stream sends an owner snapshot and only that task owner’s status events', async () => {
  const taskId = '3512c44b-8119-488e-85c0-d1b035f6857f';
  const task: TaskRecord = {
    id: taskId, userId: user.id, type: 'WRITING', status: 'RUNNING', priority: 0,
    createdAt: '2026-09-29T00:00:00.000Z', startedAt: '2026-09-29T00:00:01.000Z', completedAt: null,
    input: { text: 'private prompt', attachments: [] }, steps: [], logs: [], result: null, error: null, verification: null,
  };
  const eventHolder: { listener?: (event: TaskStatusEvent) => void } = {};
  let unsubscribeCount = 0;
  const source = {
    async start() {}, async close() {},
    subscribe(_id: string, _ownerId: string, listener: (event: TaskStatusEvent) => void) {
      eventHolder.listener = listener;
      return () => { unsubscribeCount += 1; };
    },
  } as TaskEventSource;
  const app = await buildApp({
    sessions: {
      async authenticate() { return user; },
      async consumeWebSocketTicket(ticket: string) { return ticket === 't'.repeat(43) ? user : null; },
    } as unknown as SessionService,
    auth, tasks: { async findTask(id: string, ownerId: string) { return id === taskId && ownerId === user.id ? task : null; } } as unknown as TaskRepository,
    audit, submit: {} as SubmitAssistantRequest, agents: new AgentRegistry(), taskEvents: source, logger: false,
  });

  const received: string[] = [];
  const waiters: Array<(value: string) => void> = [];
  const nextMessage = () => new Promise<string>((resolve) => {
    const value = received.shift();
    if (value !== undefined) resolve(value);
    else waiters.push(resolve);
  });
  let socket: Awaited<ReturnType<typeof app.injectWS>> | undefined;
  try {
    await app.ready();
    socket = await app.injectWS(`/v1/tasks/${taskId}/events?ticket=${'t'.repeat(43)}`, {}, {
      onOpen(client) {
        client.on('message', (data) => {
          const resolve = waiters.shift();
          if (resolve) resolve(data.toString());
          else received.push(data.toString());
        });
      },
    });
    const snapshot = JSON.parse(await nextMessage()) as Record<string, unknown>;
    assert.equal(snapshot.type, 'TASK_SNAPSHOT');
    assert.equal(snapshot.taskId, taskId);
    assert.equal(snapshot.status, 'RUNNING');
    assert.equal('result' in snapshot, false);

    assert.ok(eventHolder.listener);
    eventHolder.listener({ taskId, userId: '8a937305-9bbc-47fe-8d4c-7af8340fc4b7', status: 'FAILED', changedAt: '2026-09-29T00:00:02.000Z' });
    eventHolder.listener({ taskId, userId: user.id, status: 'VERIFYING', changedAt: '2026-09-29T00:00:03.000Z' });
    const event = JSON.parse(await nextMessage()) as Record<string, unknown>;
    assert.equal(event.type, 'TASK_STATUS');
    assert.equal(event.status, 'VERIFYING');
    assert.equal('userId' in event, false);
  } finally {
    socket?.terminate();
    await app.close();
  }
  assert.equal(unsubscribeCount, 1);
});

test('WebSocket task stream rejects invalid tickets and tasks not owned by the ticket identity', async () => {
  const taskId = '3512c44b-8119-488e-85c0-d1b035f6857f';
  let lookups = 0;
  let subscriptions = 0;
  const source = {
    async start() {}, async close() {},
    subscribe() { subscriptions += 1; return () => {}; },
  } as unknown as TaskEventSource;
  const app = await buildApp({
    sessions: {
      async authenticate() { return user; },
      async consumeWebSocketTicket(ticket: string) { return ticket === 't'.repeat(43) ? user : null; },
    } as unknown as SessionService,
    auth, tasks: { async findTask() { lookups += 1; return null; } } as unknown as TaskRepository,
    audit, submit: {} as SubmitAssistantRequest, agents: new AgentRegistry(), taskEvents: source, logger: false,
  });
  try {
    await app.ready();
    await assert.rejects(app.injectWS(`/v1/tasks/${taskId}/events?ticket=invalid`), /Unexpected server response: 401/);
    assert.equal(lookups, 0);
    await assert.rejects(app.injectWS(`/v1/tasks/${taskId}/events?ticket=${'t'.repeat(43)}`), /Unexpected server response: 404/);
    assert.equal(subscriptions, 0);
  } finally {
    await app.close();
  }
});
