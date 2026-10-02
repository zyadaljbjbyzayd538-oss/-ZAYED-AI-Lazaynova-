import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ObjectStorage, TaskArtifactRecord, TaskArtifactRepository } from '../src/application/artifact-ports.js';
import { TaskArtifactService } from '../src/infrastructure/task-artifact-service.js';

const ownerId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const taskId = '7dd4d15a-11db-4f27-810f-95525e640d2d';

class MemoryArtifactRepository implements TaskArtifactRepository {
  readonly rows = new Map<string, TaskArtifactRecord>();
  readonly deleting = new Set<string>();
  failCreate = false;
  async createArtifact(input: Omit<TaskArtifactRecord, 'createdAt'>) {
    if (this.failCreate) throw new Error('sql detail');
    const row = { ...input, createdAt: '2026-10-02T00:00:00.000Z' };
    this.rows.set(row.artifactId, row);
    const { userId: _userId, objectKey: _objectKey, ...metadata } = row;
    return metadata;
  }
  async findArtifactForOwner(id: string, userId: string) {
    const row = this.rows.get(id);
    return row?.userId === userId && !this.deleting.has(id) ? { ...row } : null;
  }
  async markArtifactDeleting(id: string, userId: string) {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId) return null;
    this.deleting.add(id);
    return row.objectKey;
  }
  async finishArtifactDelete(id: string, userId: string) {
    const row = this.rows.get(id);
    if (!row || row.userId !== userId || !this.deleting.has(id)) throw new Error('invalid deletion state');
    this.rows.delete(id);
    this.deleting.delete(id);
  }
}

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  failPut = false;
  failDelete = false;
  corruptGet = false;
  async isReady() { return true; }
  async put(input: { key: string; body: Readable; contentType: string; byteLength: number; sha256: string }) {
    if (this.failPut) throw new Error('s3 detail');
    assert.equal(input.contentType, 'application/json');
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    const body = Buffer.concat(chunks);
    assert.equal(body.length, input.byteLength);
    assert.equal(createHash('sha256').update(body).digest('hex'), input.sha256);
    this.objects.set(input.key, body);
  }
  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error('missing object');
    return Readable.from([this.corruptGet ? Buffer.concat([body, Buffer.from('x')]) : body]);
  }
  async delete(key: string) {
    if (this.failDelete) throw new Error('s3 detail');
    this.objects.delete(key);
  }
}

function setup() {
  const repository = new MemoryArtifactRepository();
  const storage = new MemoryObjectStorage();
  return { repository, storage, service: new TaskArtifactService(repository, storage) };
}

test('task artifact service stores JSON bytes outside metadata rows and serves only owner-scoped verified content', async () => {
  const { repository, storage, service } = setup();
  const body = Buffer.from(JSON.stringify({ result: 'actual external output' }));
  const artifact = await service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: 'task-output.json', body });
  const stored = repository.rows.get(artifact.artifactId)!;
  assert.equal(stored.objectKey, `tasks/${taskId}/artifacts/${artifact.artifactId}`);
  assert.equal('body' in stored, false);
  assert.equal(storage.objects.get(stored.objectKey)?.toString(), body.toString());
  assert.equal(await service.isReady(), true);
  const read = await service.readForOwner(artifact.artifactId, ownerId);
  assert.deepEqual(read.body, body);
  assert.equal(read.metadata.filename, 'task-output.json');
  await assert.rejects(() => service.readForOwner(artifact.artifactId, '3512c44b-8119-488e-85c0-d1b035f6857f'), /not found/i);
});

test('task artifact service fails closed on malformed JSON, invalid identity, oversized data, and checksum mismatch', async () => {
  const { service, storage } = setup();
  await assert.rejects(() => service.storeJson({ userId: 'invalid', taskId, kind: 'TASK_RESULT', filename: 'output.json', body: Buffer.from('{}') }), /metadata or size is invalid/i);
  await assert.rejects(() => service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: '../output.json', body: Buffer.from('{}') }), /metadata or size is invalid/i);
  await assert.rejects(() => service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: 'output.json', body: Buffer.from('{bad-json') }), /valid UTF-8 JSON/i);
  await assert.rejects(() => service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: 'output.json', body: Buffer.alloc(25 * 1024 * 1024 + 1) }), /external storage size limit/i);
  const artifact = await service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: 'output.json', body: Buffer.from('{"ok":true}') });
  storage.corruptGet = true;
  await assert.rejects(() => service.readForOwner(artifact.artifactId, ownerId), /integrity check/i);
});

test('artifact creation cleans the external object if durable metadata insertion fails', async () => {
  const { repository, storage, service } = setup();
  repository.failCreate = true;
  await assert.rejects(() => service.storeJson({ userId: ownerId, taskId, kind: 'GRAPH_NODE_RESULT', filename: 'node-step-result.json', body: Buffer.from('{"result":1}') }), /metadata could not be stored/i);
  assert.equal(repository.rows.size, 0);
  assert.equal(storage.objects.size, 0);
});

test('owner deletion marks metadata unavailable, removes object bytes, then removes metadata', async () => {
  const { repository, storage, service } = setup();
  const artifact = await service.storeJson({ userId: ownerId, taskId, kind: 'TASK_RESULT', filename: 'output.json', body: Buffer.from('{"ok":true}') });
  assert.equal(await service.deleteForOwner(artifact.artifactId, '3512c44b-8119-488e-85c0-d1b035f6857f'), false);
  assert.equal(await service.deleteForOwner(artifact.artifactId, ownerId), true);
  assert.equal(repository.rows.size, 0);
  assert.equal(storage.objects.size, 0);
});
