import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { S3ObjectStorage, createS3ObjectStorageFromEnvironment, type S3CommandClient } from '../src/infrastructure/s3-object-storage.js';

class FakeS3Client implements S3CommandClient {
  readonly commands: Array<{ name: string; input: Record<string, unknown> }> = [];
  object = Buffer.alloc(0);
  destroyed = false;

  async send(command: unknown): Promise<unknown> {
    const value = command as { constructor: { name: string }; input: Record<string, unknown> };
    this.commands.push({ name: value.constructor.name, input: value.input });
    if (value.constructor.name === 'PutObjectCommand') {
      const chunks: Buffer[] = [];
      for await (const chunk of value.input.Body as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      this.object = Buffer.concat(chunks);
    }
    if (value.constructor.name === 'GetObjectCommand') return { Body: Readable.from([this.object]) };
    return {};
  }

  destroy(): void { this.destroyed = true; }
}

const config = {
  bucket: 'lazaynova-artifacts',
  region: 'eu-central-1',
  accessKeyId: 'server-managed-access-key',
  secretAccessKey: 'server-managed-secret-key',
  endpoint: 'https://objects.example.test',
  forcePathStyle: true,
};
const taskId = '7dd4d15a-11db-4f27-810f-95525e640d2d';
const artifactId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const key = `tasks/${taskId}/artifacts/${artifactId}`;

test('S3 adapter checks readiness, streams verified bytes, requests server-side encryption and cleans up its client', async () => {
  const fake = new FakeS3Client();
  const storage = new S3ObjectStorage(config, fake);
  assert.equal(await storage.isReady(), true);
  const body = Buffer.from('{"result":"real output"}', 'utf8');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(body).digest('hex');
  await storage.put({ key, body: Readable.from([body]), contentType: 'application/json', byteLength: body.length, sha256 });
  assert.deepEqual(fake.object, body);
  const put = fake.commands.find((item) => item.name === 'PutObjectCommand')!.input;
  assert.equal(put.Bucket, config.bucket);
  assert.equal(put.Key, key);
  assert.equal(put.ServerSideEncryption, 'AES256');
  assert.equal(put.Metadata && (put.Metadata as Record<string, string>).sha256, sha256);
  assert.equal(typeof put.ChecksumSHA256, 'string');
  const got = await storage.get(key);
  const chunks: Buffer[] = [];
  for await (const chunk of got) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  assert.deepEqual(Buffer.concat(chunks), body);
  await storage.delete(key);
  assert.ok(fake.commands.some((item) => item.name === 'HeadBucketCommand'));
  assert.ok(fake.commands.some((item) => item.name === 'DeleteObjectCommand'));
  storage.close();
  assert.equal(fake.destroyed, true);
});

test('S3 adapter refuses undeclared length, digest mismatch, invalid MIME, and unsafe object keys', async () => {
  const fake = new FakeS3Client();
  const storage = new S3ObjectStorage(config, fake);
  const body = Buffer.from('{"ok":true}');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(body).digest('hex');
  await assert.rejects(() => storage.put({ key: `tasks/${taskId}/../${artifactId}`, body: Readable.from([body]), contentType: 'application/json', byteLength: body.length, sha256 }));
  await assert.rejects(() => storage.put({ key, body: Readable.from([body]), contentType: 'text/html', byteLength: body.length, sha256 }));
  await assert.rejects(() => storage.put({ key, body: Readable.from([body]), contentType: 'application/json', byteLength: body.length + 1, sha256 }));
  await assert.rejects(() => storage.put({ key, body: Readable.from([body]), contentType: 'application/json', byteLength: body.length, sha256: 'a'.repeat(64) }));
  assert.equal(fake.commands.filter((item) => item.name === 'PutObjectCommand').length, 2);
});

test('S3 environment configuration requires explicit server credentials and HTTPS endpoints', () => {
  assert.equal(createS3ObjectStorageFromEnvironment({}), undefined);
  assert.throws(() => createS3ObjectStorageFromEnvironment({ ARTIFACT_S3_BUCKET: 'bucket' }), /requires bucket, region/i);
  assert.throws(() => new S3ObjectStorage({ ...config, endpoint: 'http://objects.example.test' }, new FakeS3Client()), /must use HTTPS/i);
  assert.throws(() => new S3ObjectStorage({ ...config, endpoint: 'https://user:password@objects.example.test' }, new FakeS3Client()), /must use HTTPS/i);
  assert.throws(() => new S3ObjectStorage({ ...config, accessKeyId: '' }, new FakeS3Client()), /credentials must be explicitly configured/i);
});
