import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  MAX_TASK_ARTIFACT_BYTES,
  TASK_ARTIFACT_CONTENT_TYPE,
  type ObjectStorage,
  type TaskArtifactKind,
  type TaskArtifactMetadata,
  type TaskArtifactRecord,
  type TaskArtifactRepository,
  type TaskArtifactWriter,
} from '../application/artifact-ports.js';
import { HttpError } from '../domain/errors.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILENAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;

async function collectBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    byteLength += chunk.length;
    if (byteLength > limit) {
      stream.destroy();
      throw new HttpError(413, 'ARTIFACT_TOO_LARGE', 'The stored artifact exceeded its size limit.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteLength);
}

function metadataOnly(record: TaskArtifactRecord): TaskArtifactMetadata {
  return {
    artifactId: record.artifactId,
    taskId: record.taskId,
    kind: record.kind,
    filename: record.filename,
    contentType: record.contentType,
    byteLength: record.byteLength,
    sha256: record.sha256,
    createdAt: record.createdAt,
  };
}

/** Owner-scoped, content-address-verified task results stored outside PostgreSQL JSONB. */
export class TaskArtifactService implements TaskArtifactWriter {
  constructor(private readonly repository: TaskArtifactRepository, private readonly storage: ObjectStorage) {}

  async isReady(): Promise<boolean> {
    try { return await this.storage.isReady(); } catch { return false; }
  }

  async storeJson(input: { userId: string; taskId: string; kind: TaskArtifactKind; filename: string; body: Buffer }): Promise<TaskArtifactMetadata> {
    if (!UUID_PATTERN.test(input.userId) || !UUID_PATTERN.test(input.taskId) ||
        !['TASK_RESULT', 'GRAPH_NODE_RESULT'].includes(input.kind) || !FILENAME_PATTERN.test(input.filename) || input.body.length === 0) {
      throw new HttpError(400, 'ARTIFACT_INPUT_INVALID', 'The task artifact metadata or size is invalid.');
    }
    if (input.body.length > MAX_TASK_ARTIFACT_BYTES) throw new HttpError(413, 'ARTIFACT_TOO_LARGE', 'The task result exceeded its external storage size limit.');
    const jsonText = input.body.toString('utf8');
    if (!Buffer.from(jsonText, 'utf8').equals(input.body)) throw new HttpError(400, 'ARTIFACT_INPUT_INVALID', 'Task result artifacts must contain valid UTF-8 JSON.');
    try { JSON.parse(jsonText) as unknown; }
    catch { throw new HttpError(400, 'ARTIFACT_INPUT_INVALID', 'Task result artifacts must contain valid UTF-8 JSON.'); }

    const artifactId = randomUUID();
    const objectKey = `tasks/${input.taskId}/artifacts/${artifactId}`;
    const sha256 = createHash('sha256').update(input.body).digest('hex');
    try {
      await this.storage.put({
        key: objectKey,
        body: Readable.from([input.body]),
        contentType: TASK_ARTIFACT_CONTENT_TYPE,
        byteLength: input.body.length,
        sha256,
      });
    } catch {
      throw new HttpError(503, 'ARTIFACT_STORAGE_FAILED', 'The external artifact store could not save this result.');
    }

    try {
      return await this.repository.createArtifact({
        artifactId,
        userId: input.userId,
        taskId: input.taskId,
        kind: input.kind,
        filename: input.filename,
        contentType: TASK_ARTIFACT_CONTENT_TYPE,
        byteLength: input.body.length,
        sha256,
        objectKey,
      });
    } catch {
      try { await this.storage.delete(objectKey); }
      catch { throw new HttpError(503, 'ARTIFACT_CLEANUP_FAILED', 'An unreferenced artifact could not be removed safely.'); }
      throw new HttpError(503, 'ARTIFACT_METADATA_FAILED', 'Artifact metadata could not be stored safely.');
    }
  }

  async readForOwner(artifactId: string, userId: string): Promise<{ metadata: TaskArtifactMetadata; body: Buffer }> {
    if (!UUID_PATTERN.test(artifactId) || !UUID_PATTERN.test(userId)) throw new HttpError(400, 'ARTIFACT_ID_INVALID', 'The artifact reference is invalid.');
    const record = await this.repository.findArtifactForOwner(artifactId, userId);
    if (!record) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'The artifact was not found.');
    let body: Buffer;
    try {
      body = await collectBounded(await this.storage.get(record.objectKey), MAX_TASK_ARTIFACT_BYTES);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'ARTIFACT_STORAGE_UNAVAILABLE', 'The stored artifact could not be retrieved.');
    }
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (body.length !== record.byteLength || sha256 !== record.sha256) {
      throw new HttpError(503, 'ARTIFACT_INTEGRITY_CHECK_FAILED', 'The stored artifact failed its integrity check.');
    }
    const jsonText = body.toString('utf8');
    try {
      if (!Buffer.from(jsonText, 'utf8').equals(body)) throw new Error('invalid UTF-8');
      JSON.parse(jsonText) as unknown;
    } catch {
      throw new HttpError(503, 'ARTIFACT_INTEGRITY_CHECK_FAILED', 'The stored artifact is not valid UTF-8 JSON.');
    }
    return { metadata: metadataOnly(record), body };
  }

  async deleteForOwner(artifactId: string, userId: string): Promise<boolean> {
    if (!UUID_PATTERN.test(artifactId) || !UUID_PATTERN.test(userId)) throw new HttpError(400, 'ARTIFACT_ID_INVALID', 'The artifact reference is invalid.');
    const objectKey = await this.repository.markArtifactDeleting(artifactId, userId);
    if (!objectKey) return false;
    try { await this.storage.delete(objectKey); }
    catch { throw new HttpError(503, 'ARTIFACT_DELETE_FAILED', 'The artifact could not be removed from external storage.'); }
    try { await this.repository.finishArtifactDelete(artifactId, userId); }
    catch { throw new HttpError(503, 'ARTIFACT_DELETE_PENDING', 'Artifact deletion is pending metadata cleanup.'); }
    return true;
  }
}
