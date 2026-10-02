import test from 'node:test';
import assert from 'node:assert/strict';
import { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { FileService } from '../src/application/file-ports.js';
import { HttpError } from '../src/domain/errors.js';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import type { AuthenticatedUser, TaskRecord } from '../src/domain/types.js';
import type { AuthRepository, TaskRepository } from '../src/application/ports.js';

const user: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'owner@example.test', role: 'USER', sessionId: 'session-1' };
const fileId = 'cdb77fc1-3fc2-4776-a28d-d93098559f67';
class Auth {
  async hasCapability() { return true; }
  async hasToolGrant() { return true; }
}
class Tasks {
  created: unknown[] = [];
  async createTask(input: unknown) { this.created.push(input); return { id: 'task-1', createdAt: '2026-09-29T00:00:00.000Z' }; }
  async findTask(): Promise<TaskRecord | null> { return null; }
  async findTaskForWorker(): Promise<TaskRecord | null> { return null; }
  async transitionTask(): Promise<boolean> { return true; }
  async appendTaskLog(): Promise<void> {}
}

function buildUseCase(tasks: Tasks, files: FileService) {
  const agents = new AgentRegistry();
  const driver: CapabilityDriver = {
    capability: 'FILE_ANALYSIS',
    async isReady() { return true; },
    async execute() { return { result: { text: 'summary' }, evidence: [] }; },
  };
  agents.register(driver);
  return new SubmitAssistantRequest(new Auth() as unknown as AuthRepository, tasks as unknown as TaskRepository, agents, files);
}

const fileService = (getMetadata: FileService['getMetadata']): FileService => ({
  async isReady() { return true; },
  async createUpload() { throw new Error('not used'); },
  getMetadata,
  async parseForAnalysis() { throw new Error('not used'); },
  async delete() { return false; },
});

test('FILE_ANALYSIS accepts one owned UUID, checks ownership before persistence, and stores the reference', async () => {
  const tasks = new Tasks();
  let lookup: { userId: string; fileId: string } | undefined;
  const files = fileService(async (input) => {
    lookup = input;
    return { fileId, filename: 'notes.txt', contentType: 'text/plain', byteLength: 12, sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z' };
  });
  const useCase = buildUseCase(tasks, files);
  const result = await useCase.submitCapability(user, 'FILE_ANALYSIS', { text: 'Summarize the file', attachments: [fileId] });
  assert.equal(result.type, 'FILE_ANALYSIS');
  assert.deepEqual(lookup, { userId: user.id, fileId });
  assert.deepEqual(tasks.created, [{
    userId: user.id, capability: 'FILE_ANALYSIS',
    taskInput: { text: 'Summarize the file', attachments: [fileId] },
  }]);
});

test('assistant requests with an uploaded file route to File Analysis instead of direct Chat', async () => {
  const tasks = new Tasks();
  const files = fileService(async () => ({ fileId, filename: 'notes.txt', contentType: 'text/plain', byteLength: 12, sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z' }));
  const useCase = buildUseCase(tasks, files);
  const result = await useCase.execute(user, { text: 'Summarize this', attachments: [fileId] });
  assert.equal(result.kind, 'TASK');
  if (result.kind === 'TASK') assert.equal(result.type, 'FILE_ANALYSIS');
  assert.equal(tasks.created.length, 1);
});

test('FILE_ANALYSIS rejects missing, multiple, invalid, or non-owned files before creating a task', async () => {
  const tasks = new Tasks();
  const files = fileService(async () => { throw new HttpError(404, 'FILE_NOT_FOUND', 'The file was not found.'); });
  const useCase = buildUseCase(tasks, files);
  await assert.rejects(() => useCase.submitCapability(user, 'FILE_ANALYSIS', { text: 'Analyze', attachments: [] }), (error: unknown) => (error as { code?: string }).code === 'FILE_REQUIRED');
  await assert.rejects(() => useCase.submitCapability(user, 'FILE_ANALYSIS', { text: 'Analyze', attachments: [fileId, fileId] }), (error: unknown) => (error as { code?: string }).code === 'TOO_MANY_FILES');
  await assert.rejects(() => useCase.submitCapability(user, 'FILE_ANALYSIS', { text: 'Analyze', attachments: ['not-a-uuid'] }), (error: unknown) => (error as { code?: string }).code === 'INVALID_FILE_ID');
  await assert.rejects(() => useCase.submitCapability(user, 'FILE_ANALYSIS', { text: 'Analyze', attachments: [fileId] }), (error: unknown) => (error as { code?: string }).code === 'FILE_NOT_FOUND');
  assert.equal(tasks.created.length, 0);
});
