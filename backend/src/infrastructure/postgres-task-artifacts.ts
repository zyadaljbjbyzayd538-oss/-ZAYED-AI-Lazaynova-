import { Pool } from 'pg';
import type { TaskArtifactKind, TaskArtifactMetadata, TaskArtifactRecord, TaskArtifactRepository } from '../application/artifact-ports.js';
import { withTransaction } from './postgres.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function toRecord(row: Record<string, unknown>): TaskArtifactRecord {
  return {
    artifactId: String(row.id),
    userId: String(row.user_id),
    taskId: String(row.task_id),
    kind: row.artifact_kind as TaskArtifactKind,
    filename: String(row.filename),
    contentType: 'application/json',
    byteLength: Number(row.byte_length),
    sha256: String(row.sha256),
    objectKey: String(row.object_key),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

function metadata(record: TaskArtifactRecord): TaskArtifactMetadata {
  const { userId: _owner, objectKey: _key, ...publicMetadata } = record;
  return publicMetadata;
}

/** Owner-scoped object metadata; object bytes are never stored in PostgreSQL. */
export class PostgresTaskArtifactRepository implements TaskArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async createArtifact(input: Omit<TaskArtifactRecord, 'createdAt'>): Promise<TaskArtifactMetadata> {
    if (!UUID_PATTERN.test(input.artifactId) || !UUID_PATTERN.test(input.userId) || !UUID_PATTERN.test(input.taskId) || !SHA256_PATTERN.test(input.sha256)) {
      throw new Error('Artifact metadata identity is invalid.');
    }
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO task_artifacts
           (id, user_id, task_id, artifact_kind, filename, content_type, byte_length, sha256, object_key)
         SELECT $1, $2, task.id, $4, $5, $6, $7, $8, $9
         FROM tasks AS task WHERE task.id = $3 AND task.user_id = $2
         RETURNING id, user_id, task_id, artifact_kind, filename, content_type, byte_length, sha256, object_key, created_at`,
        [input.artifactId, input.userId, input.taskId, input.kind, input.filename, input.contentType, input.byteLength, input.sha256, input.objectKey],
      );
      if (inserted.rowCount !== 1) throw new Error('Artifact task owner was not found.');
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'TASK_ARTIFACT_STORED', 'task', $2, $3::jsonb)`,
        [input.userId, input.taskId, JSON.stringify({ artifactId: input.artifactId, kind: input.kind, byteLength: input.byteLength, sha256: input.sha256 })],
      );
      return metadata(toRecord(inserted.rows[0] as Record<string, unknown>));
    });
  }

  async findArtifactForOwner(artifactId: string, userId: string): Promise<TaskArtifactRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, task_id, artifact_kind, filename, content_type, byte_length, sha256, object_key, created_at
       FROM task_artifacts WHERE id = $1 AND user_id = $2 AND status = 'READY'`,
      [artifactId, userId],
    );
    return result.rows[0] ? toRecord(result.rows[0] as Record<string, unknown>) : null;
  }

  async markArtifactDeleting(artifactId: string, userId: string): Promise<string | null> {
    const result = await this.pool.query(
      `UPDATE task_artifacts SET status = 'DELETING'
       WHERE id = $1 AND user_id = $2 AND status IN ('READY', 'DELETING')
       RETURNING object_key`,
      [artifactId, userId],
    );
    return result.rows[0] ? String(result.rows[0].object_key) : null;
  }

  async finishArtifactDelete(artifactId: string, userId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const deleted = await client.query(
        `DELETE FROM task_artifacts WHERE id = $1 AND user_id = $2 AND status = 'DELETING'
         RETURNING task_id`,
        [artifactId, userId],
      );
      if (deleted.rowCount !== 1) throw new Error('Artifact deletion state changed.');
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'TASK_ARTIFACT_DELETED', 'task', $2, $3::jsonb)`,
        [userId, deleted.rows[0].task_id, JSON.stringify({ artifactId })],
      );
    });
  }
}
