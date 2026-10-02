import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { FileMetadata, FileService } from '../src/application/file-ports.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { AuthenticatedUser } from '../src/domain/types.js';

const user: AuthenticatedUser = {
  id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'owner@example.test', role: 'USER', sessionId: 'session-1',
};
const headers = { authorization: `Bearer ${'t'.repeat(40)}` };
const metadata: FileMetadata = {
  fileId: 'cdb77fc1-3fc2-4776-a28d-d93098559f67', filename: 'notes.txt', contentType: 'text/plain',
  byteLength: 12, sha256: 'a'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z',
};

async function makeApp(options: { granted?: boolean; files?: FileService; submitCapability?: SubmitAssistantRequest['submitCapability'] } = {}) {
  return buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth: { async hasCapability() { return options.granted ?? false; } } as unknown as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: { async execute() { throw new Error('unexpected assistant request'); }, submitCapability: options.submitCapability } as unknown as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    ...(options.files ? { files: options.files } : {}),
    rateLimit: { max: 100, timeWindow: '1 minute' },
    logger: false,
  });
}

const service = (overrides: Partial<FileService> = {}): FileService => ({
  async isReady() { return true; },
  async createUpload(input) { return { ...metadata, filename: input.filename, contentType: input.contentType, byteLength: Buffer.from(input.contentBase64, 'base64').length }; },
  async getMetadata(input) { if (input.userId !== user.id || input.fileId !== metadata.fileId) throw Object.assign(new Error('not found'), { statusCode: 404, code: 'FILE_NOT_FOUND' }); return metadata; },
  async parseForAnalysis() { throw new Error('not used by the HTTP route test'); },
  async delete(input) { return input.userId === user.id && input.fileId === metadata.fileId; },
  ...overrides,
});

test('file upload requires authentication and the explicit FILE_ANALYSIS grant', async () => {
  let uploads = 0;
  const files = service({ async createUpload() { uploads += 1; return metadata; } });
  const app = await makeApp({ files });
  try {
    const unauthenticated = await app.inject({ method: 'POST', url: '/v1/files', payload: { filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('private text').toString('base64') } });
    assert.equal(unauthenticated.statusCode, 401);
    const forbidden = await app.inject({ method: 'POST', url: '/v1/files', headers, payload: { filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('private text').toString('base64') } });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(uploads, 0);
  } finally {
    await app.close();
  }
});

test('authorized upload returns metadata only and owner-scoped metadata/deletion routes do not expose content', async () => {
  let observedUpload: { userId: string; filename: string; contentBase64: string } | undefined;
  let deletedOwner: string | undefined;
  const files = service({
    async createUpload(input) {
      observedUpload = { userId: input.userId, filename: input.filename, contentBase64: input.contentBase64 };
      return metadata;
    },
    async delete(input) { deletedOwner = input.userId; return input.fileId === metadata.fileId && input.userId === user.id; },
  });
  const app = await makeApp({ granted: true, files });
  const contentBase64 = Buffer.from('private text').toString('base64');
  try {
    const uploadResponse = await app.inject({
      method: 'POST', url: '/v1/files', headers,
      payload: { filename: 'notes.txt', contentType: 'text/plain', contentBase64 },
    });
    assert.equal(uploadResponse.statusCode, 201);
    assert.deepEqual(observedUpload, { userId: user.id, filename: 'notes.txt', contentBase64 });
    assert.equal('contentBase64' in uploadResponse.json(), false);
    assert.equal('text' in uploadResponse.json(), false);

    const metadataResponse = await app.inject({ method: 'GET', url: `/v1/files/${metadata.fileId}`, headers });
    assert.equal(metadataResponse.statusCode, 200);
    assert.equal(metadataResponse.json().fileId, metadata.fileId);
    assert.equal('contentBase64' in metadataResponse.json(), false);

    const deleteResponse = await app.inject({ method: 'DELETE', url: `/v1/files/${metadata.fileId}`, headers });
    assert.equal(deleteResponse.statusCode, 204);
    assert.equal(deletedOwner, user.id);
  } finally {
    await app.close();
  }
});

test('explicit file-analysis task forwards the uploaded file reference only for FILE_ANALYSIS', async () => {
  const observed: { value: unknown } = { value: null };
  const app = await makeApp({ granted: true, submitCapability: async (authenticatedUser, capability, input) => {
    observed.value = { userId: authenticatedUser.id, capability, input };
    return { kind: 'TASK', taskId: 'task-1', status: 'QUEUED', createdAt: '2026-09-29T00:00:00.000Z', type: capability };
  } });
  try {
    const accepted = await app.inject({
      method: 'POST', url: '/v1/tasks/execute', headers,
      payload: { capability: 'FILE_ANALYSIS', prompt: 'Summarize', attachments: [metadata.fileId] },
    });
    assert.equal(accepted.statusCode, 202);
    assert.deepEqual(observed.value, {
      userId: user.id, capability: 'FILE_ANALYSIS', input: { text: 'Summarize', attachments: [metadata.fileId] },
    });
    const rejected = await app.inject({
      method: 'POST', url: '/v1/tasks/execute', headers,
      payload: { capability: 'WRITING', prompt: 'Summarize', attachments: [metadata.fileId] },
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.json().error.code, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS');
  } finally {
    await app.close();
  }
});

test('file upload fails closed when encryption is not configured and rejects invalid request data', async () => {
  const unavailable = await makeApp({ granted: true, files: service({ async isReady() { return false; } }) });
  try {
    const response = await unavailable.inject({ method: 'POST', url: '/v1/files', headers, payload: { filename: 'notes.txt', contentType: 'text/plain', contentBase64: Buffer.from('private text').toString('base64') } });
    assert.equal(response.statusCode, 501);
    assert.equal(response.json().error.code, 'FILE_SERVICE_UNAVAILABLE');
  } finally {
    await unavailable.close();
  }

  const ready = await makeApp({ granted: true, files: service() });
  try {
    const response = await ready.inject({ method: 'POST', url: '/v1/files', headers, payload: { filename: 'notes.pdf', contentType: 'application/pdf', contentBase64: '!!!!' } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
  } finally {
    await ready.close();
  }
});
