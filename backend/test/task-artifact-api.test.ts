import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { TaskArtifactMetadata, TaskArtifactWriter } from '../src/application/artifact-ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { AuthenticatedUser } from '../src/domain/types.js';

const user: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'owner@example.test', role: 'USER', sessionId: 'session-1' };
const artifactId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const taskId = '7dd4d15a-11db-4f27-810f-95525e640d2d';
const metadata: TaskArtifactMetadata = {
  artifactId, taskId, kind: 'TASK_RESULT', filename: 'task-output.json', contentType: 'application/json',
  byteLength: 16, sha256: 'a'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z',
};
const headers = { authorization: `Bearer ${'t'.repeat(40)}` };

async function makeApp(taskArtifacts?: Pick<TaskArtifactWriter, 'readForOwner' | 'deleteForOwner'>) {
  return buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    ...(taskArtifacts ? { taskArtifacts } : {}),
    rateLimit: { max: 100, timeWindow: '1 minute' },
    logger: false,
  });
}

test('artifact content route is authenticated, owner scoped, and returns verified JSON bytes without caching', async () => {
  const body = Buffer.from('{"result":"real"}');
  let readOwner = '';
  const service = {
    async readForOwner(id: string, owner: string) {
      assert.equal(id, artifactId);
      readOwner = owner;
      if (owner !== user.id) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'ARTIFACT_NOT_FOUND' });
      return { metadata, body };
    },
    async deleteForOwner() { return false; },
  };
  const app = await makeApp(service);
  try {
    const denied = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}/content` });
    assert.equal(denied.statusCode, 401);
    const response = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}/content`, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['content-disposition'], 'attachment; filename="task-output.json"');
    assert.deepEqual(response.rawPayload, body);
    assert.equal(readOwner, user.id);
  } finally {
    await app.close();
  }
});

test('artifact deletion is owner scoped and unavailable when object storage is not configured', async () => {
  let deletedOwner = '';
  let deletionCount = 0;
  const app = await makeApp({
    async readForOwner() { throw new Error('not used'); },
    async deleteForOwner(id: string, owner: string) { assert.equal(id, artifactId); deletedOwner = owner; deletionCount += 1; return owner === user.id && deletionCount === 1; },
  });
  const unavailable = await makeApp();
  try {
    const removed = await app.inject({ method: 'DELETE', url: `/v1/artifacts/${artifactId}`, headers });
    assert.equal(removed.statusCode, 204);
    assert.equal(deletedOwner, user.id);
    const missing = await app.inject({ method: 'DELETE', url: `/v1/artifacts/${artifactId}`, headers, remoteAddress: '127.0.0.2' });
    assert.equal(missing.statusCode, 404);
    const noStorage = await unavailable.inject({ method: 'GET', url: `/v1/artifacts/${artifactId}/content`, headers });
    assert.equal(noStorage.statusCode, 501);
  } finally {
    await app.close();
    await unavailable.close();
  }
});
