import { createHash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { MAX_TASK_ARTIFACT_BYTES, type ObjectStorage } from '../application/artifact-ports.js';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const OBJECT_KEY_PATTERN = new RegExp(`^tasks/${UUID_PATTERN}/artifacts/${UUID_PATTERN}$`, 'i');
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface S3ObjectStorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  forcePathStyle?: boolean;
}

export interface S3CommandClient {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
}

class VerifiedUploadStream extends Transform {
  private readonly hash = createHash('sha256');
  private byteLength = 0;

  constructor(private readonly expectedByteLength: number, private readonly expectedSha256: string) { super(); }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.byteLength += bytes.length;
    if (this.byteLength > this.expectedByteLength || this.byteLength > MAX_TASK_ARTIFACT_BYTES) {
      callback(new Error('Upload stream exceeded the declared artifact size.'));
      return;
    }
    this.hash.update(bytes);
    callback(null, bytes);
  }

  override _flush(callback: TransformCallback): void {
    if (this.byteLength !== this.expectedByteLength || this.hash.digest('hex') !== this.expectedSha256.toLowerCase()) {
      callback(new Error('Upload stream did not match the declared artifact digest.'));
      return;
    }
    callback();
  }
}

function validateObjectKey(key: string): void {
  if (!OBJECT_KEY_PATTERN.test(key)) throw new Error('Artifact object key is invalid.');
}

function validateEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error('ARTIFACT_S3_ENDPOINT must be a valid HTTPS URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1') {
    throw new Error('ARTIFACT_S3_ENDPOINT must use HTTPS and contain no credentials, query, or fragment.');
  }
  return parsed.toString().replace(/\/$/, '');
}

/** S3-compatible private object store. It refuses ambient credentials and plaintext endpoints. */
export class S3ObjectStorage implements ObjectStorage {
  private readonly endpoint: string | undefined;
  private readonly client: S3CommandClient;

  constructor(
    private readonly config: S3ObjectStorageConfig,
    client?: S3CommandClient,
  ) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(config.bucket) || config.bucket.includes('..')) {
      throw new Error('ARTIFACT_S3_BUCKET is invalid.');
    }
    if (!/^[a-z0-9-]{2,64}$/i.test(config.region)) throw new Error('ARTIFACT_S3_REGION is invalid.');
    if (!config.accessKeyId.trim() || !config.secretAccessKey.trim() || /[\u0000-\u001f\u007f]/.test(config.accessKeyId + config.secretAccessKey)) {
      throw new Error('Artifact S3 credentials must be explicitly configured through server-side secret storage.');
    }
    this.endpoint = validateEndpoint(config.endpoint);
    this.client = client ?? new S3Client({
      region: config.region,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3_000, socketTimeout: 15_000 }),
    });
  }

  close(): void { this.client.destroy?.(); }

  async isReady(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      return true;
    } catch { return false; }
  }

  async put(input: { key: string; body: Readable; contentType: string; byteLength: number; sha256: string }): Promise<void> {
    validateObjectKey(input.key);
    if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MAX_TASK_ARTIFACT_BYTES ||
        !SHA256_PATTERN.test(input.sha256) || input.contentType !== 'application/json') {
      throw new Error('Artifact upload metadata is invalid.');
    }
    const body = input.body.pipe(new VerifiedUploadStream(input.byteLength, input.sha256));
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      Body: body,
      ContentLength: input.byteLength,
      ContentType: input.contentType,
      ChecksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
      ServerSideEncryption: 'AES256',
      Metadata: { sha256: input.sha256.toLowerCase() },
    }));
  }

  async get(key: string): Promise<Readable> {
    validateObjectKey(key);
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key })) as { Body?: unknown };
    const body = response.Body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') throw new Error('Artifact object body is unavailable.');
    return body;
  }

  async delete(key: string): Promise<void> {
    validateObjectKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

export function createS3ObjectStorageFromEnvironment(env: NodeJS.ProcessEnv): S3ObjectStorage | undefined {
  const names = [
    'ARTIFACT_S3_BUCKET', 'ARTIFACT_S3_REGION', 'ARTIFACT_S3_ACCESS_KEY_ID', 'ARTIFACT_S3_SECRET_ACCESS_KEY',
  ] as const;
  const values = names.map((name) => env[name]?.trim() ?? '');
  const endpoint = env.ARTIFACT_S3_ENDPOINT?.trim();
  const forcePathStyleText = env.ARTIFACT_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  const configured = values.some(Boolean) || Boolean(endpoint) || Boolean(forcePathStyleText);
  if (!configured) return undefined;
  if (values.some((value) => !value)) throw new Error('Artifact S3 configuration requires bucket, region, access key ID, and secret access key.');
  if (forcePathStyleText && !['true', 'false'].includes(forcePathStyleText)) {
    throw new Error('ARTIFACT_S3_FORCE_PATH_STYLE must be true or false.');
  }
  return new S3ObjectStorage({
    bucket: values[0]!,
    region: values[1]!,
    accessKeyId: values[2]!,
    secretAccessKey: values[3]!,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyleText ? forcePathStyleText === 'true' : true,
  });
}
