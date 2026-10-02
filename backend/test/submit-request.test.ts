import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitAssistantRequest } from '../src/application/submit-request.js';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import { CapabilityPermissionError, CapabilityUnavailableError, HttpError } from '../src/domain/errors.js';
import type { AuthenticatedUser, Capability, TaskRecord } from '../src/domain/types.js';
import type { AuthRepository, TaskRepository } from '../src/application/ports.js';
import type { Planner } from '../src/application/orchestration-ports.js';

const user: AuthenticatedUser = { id: 'user-1', email: 'user@example.test', role: 'USER', sessionId: 'session-1' };
class FakeAuth {
  granted = true;
  toolGranted = true;
  async hasCapability(): Promise<boolean> { return this.granted; }
  async hasToolGrant(): Promise<boolean> { return this.toolGranted; }
}
class FakeTasks {
  created: unknown[] = [];
  async createTask(input: unknown): Promise<{ id: string; createdAt: string }> {
    this.created.push(input);
    return { id: 'task-1', createdAt: '2026-09-29T00:00:00.000Z' };
  }
  async findTask(): Promise<TaskRecord | null> { return null; }
  async findTaskForWorker(): Promise<TaskRecord | null> { return null; }
  async transitionTask(): Promise<boolean> { return true; }
  async appendTaskLog(): Promise<void> {}
}
const fakeAudit = { async writeAudit() {} };
const driver = (capability: Capability, ready: boolean, calls: string[] = []): CapabilityDriver => ({
  capability,
  async isReady() { return ready; },
  async execute() { calls.push(capability); return { result: { text: 'real driver output' }, evidence: [] }; },
});

test('permission is checked before readiness and before task persistence', async () => {
  const auth = new FakeAuth(); auth.granted = false;
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('WRITING', false));
  const useCase = new SubmitAssistantRequest(auth as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  await assert.rejects(() => useCase.execute(user, { text: 'اكتب رسالة اعتذار' }), CapabilityPermissionError);
  assert.equal(tasks.created.length, 0);
});

test('unavailable engine returns before task persistence', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('WRITING', false));
  const useCase = new SubmitAssistantRequest(new FakeAuth() as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  await assert.rejects(() => useCase.execute(user, { text: 'اكتب رسالة اعتذار' }), CapabilityUnavailableError);
  assert.equal(tasks.created.length, 0);
});

test('unready selected planner is part of task preflight and cannot accept work', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('WRITING', true));
  const planner: Planner = { async isReady() { return false; }, async plan() { throw new Error('must not plan'); } };
  const useCase = new SubmitAssistantRequest(
    new FakeAuth() as unknown as AuthRepository,
    tasks as unknown as TaskRepository,
    agents,
    undefined,
    planner,
  );
  await assert.rejects(() => useCase.execute(user, { text: 'اكتب رسالة اعتذار' }), CapabilityUnavailableError);
  assert.equal(tasks.created.length, 0);
});

test('simple chat calls a ready driver directly and never creates a queued task', async () => {
  const tasks = new FakeTasks();
  const calls: string[] = [];
  const agents = new AgentRegistry();
  agents.register(driver('CHAT', true, calls));
  const useCase = new SubmitAssistantRequest(new FakeAuth() as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  const response = await useCase.execute(user, { text: 'السلام عليكم' });
  assert.deepEqual(response, { kind: 'CHAT', result: { text: 'real driver output' }, evidence: [] });
  assert.deepEqual(calls, ['CHAT']);
  assert.equal(tasks.created.length, 0);
});

test('ready capability delegates task acceptance only after preflight', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('WRITING', true));
  const useCase = new SubmitAssistantRequest(new FakeAuth() as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  const response = await useCase.execute(user, { text: 'اكتب رسالة اعتذار' });
  assert.deepEqual(response, { kind: 'TASK', taskId: 'task-1', status: 'QUEUED', createdAt: '2026-09-29T00:00:00.000Z', type: 'WRITING' });
  assert.equal(tasks.created.length, 1);
});

test('Web Research requires its distinct web.search grant before creating a task', async () => {
  const auth = new FakeAuth();
  auth.toolGranted = false;
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('WEB_RESEARCH', true));
  const useCase = new SubmitAssistantRequest(auth as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  await assert.rejects(
    () => useCase.submitCapability(user, 'WEB_RESEARCH', { text: 'Find sources' }),
    (error: unknown) => error instanceof HttpError && error.code === 'TOOL_PERMISSION_DENIED',
  );
  assert.equal(tasks.created.length, 0);
});

test('explicit MODEL_ANALYSIS task preserves structured params after grant and readiness checks', async () => {
  const tasks = new FakeTasks();
  const agents = new AgentRegistry();
  agents.register(driver('MODEL_ANALYSIS', true));
  const useCase = new SubmitAssistantRequest(new FakeAuth() as unknown as AuthRepository, tasks as unknown as TaskRepository, agents);
  const result = await useCase.submitCapability(user, 'MODEL_ANALYSIS', {
    text: 'Analyze this model output',
    params: { modelId: 'model-7', temperature: 0.1 },
  });
  assert.equal(result.type, 'MODEL_ANALYSIS');
  assert.deepEqual(tasks.created, [{
    userId: user.id,
    capability: 'MODEL_ANALYSIS',
    taskInput: { text: 'Analyze this model output', attachments: [], params: { modelId: 'model-7', temperature: 0.1 } },
  }]);
});
