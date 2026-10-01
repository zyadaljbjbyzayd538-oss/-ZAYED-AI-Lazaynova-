import { Pool, type PoolClient } from 'pg';
import type { AuditRepository, AuthRepository, TaskRepository } from '../application/ports.js';
import type { TaskGraphRepository } from '../application/orchestration-ports.js';
import type { EncryptedFileRecord, FileMetadata, FileRepository } from '../application/file-ports.js';
import { assertTransition } from '../domain/task-state.js';
import { HttpError } from '../domain/errors.js';
import type { AuthenticatedUser, AgentResult, Capability, TaskCapability, TaskInput, TaskRecord, TaskStatus, ToolName, ToolUsageDecision, UserIdentity, VerificationResult } from '../domain/types.js';
import { hashAgentPlan, type AgentPlan, type GraphNodeStatus, type TaskGraphSnapshot } from '../domain/task-graph.js';

export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, max: 15, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export class PostgresRepositories implements AuthRepository, TaskRepository, TaskGraphRepository, AuditRepository, FileRepository {
  constructor(private readonly pool: Pool) {}

  async findSessionByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedUser | null> {
    const result = await this.pool.query(
      `SELECT u.id, u.email, u.role, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > $2 AND s.revoked_at IS NULL AND u.disabled_at IS NULL`,
      [tokenHash, now],
    );
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, role: row.role, sessionId: row.session_id } : null;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const session = await client.query(
        'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
        [userId, tokenHash, expiresAt],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'SESSION_CREATED', 'session', $2, '{}'::jsonb)`,
        [userId, session.rows[0].id],
      );
    });
  }

  async createWebSocketTicket(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query("DELETE FROM websocket_tickets WHERE expires_at < now() - interval '1 day'");
      const ticket = await client.query(
        'INSERT INTO websocket_tickets (user_id, token_hash, expires_at) VALUES ($1, $2, $3) RETURNING id',
        [userId, tokenHash, expiresAt],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'WEBSOCKET_TICKET_CREATED', 'websocket_ticket', $2, '{}'::jsonb)`,
        [userId, ticket.rows[0].id],
      );
    });
  }

  async consumeWebSocketTicket(tokenHash: string, now: Date): Promise<UserIdentity | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE websocket_tickets wt SET consumed_at = $2
         FROM users u
         WHERE wt.user_id = u.id AND wt.token_hash = $1 AND wt.consumed_at IS NULL
           AND wt.expires_at > $2 AND u.disabled_at IS NULL
         RETURNING u.id, u.email, u.role, wt.id AS ticket_id`,
        [tokenHash, now],
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'WEBSOCKET_TICKET_CONSUMED', 'websocket_ticket', $2, '{}'::jsonb)`,
        [row.id, row.ticket_id],
      );
      return { id: row.id, email: row.email, role: row.role };
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const revoked = await client.query(
        'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_id',
        [sessionId],
      );
      if (revoked.rowCount === 1) {
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'SESSION_REVOKED', 'session', $2, '{}'::jsonb)`,
          [revoked.rows[0].user_id, sessionId],
        );
      }
    });
  }

  async findUserByEmail(email: string): Promise<{ id: string; email: string; role: 'USER' | 'ADMIN'; passwordHash: string } | null> {
    const result = await this.pool.query('SELECT id, email, role, password_hash FROM users WHERE email = $1 AND disabled_at IS NULL', [email]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, role: row.role, passwordHash: row.password_hash } : null;
  }

  async findUserById(userId: string): Promise<{ id: string; email: string; role: 'USER' | 'ADMIN' } | null> {
    const result = await this.pool.query('SELECT id, email, role FROM users WHERE id = $1 AND disabled_at IS NULL', [userId]);
    const row = result.rows[0];
    return row ? { id: row.id, email: row.email, role: row.role } : null;
  }

  async createUser(email: string, passwordHash: string, role: 'USER' | 'ADMIN'): Promise<string> {
    try {
      const result = await this.pool.query(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
        [email.toLowerCase(), passwordHash, role],
      );
      return result.rows[0].id as string;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
        throw new HttpError(409, 'USER_ALREADY_EXISTS', 'An account with this email already exists.');
      }
      throw error;
    }
  }

  async grantCapability(userId: string, capability: Capability, grantedBy: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO user_capability_grants (user_id, capability, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, capability) DO UPDATE
         SET granted_by = EXCLUDED.granted_by, granted_at = now(), expires_at = NULL, revoked_at = NULL`,
        [userId, capability, grantedBy],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'CAPABILITY_GRANTED', 'user', $2, $3::jsonb)`,
        [grantedBy, userId, JSON.stringify({ capability })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeCapability(userId: string, capability: Capability, revokedBy: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE user_capability_grants SET revoked_at = now() WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL',
        [userId, capability],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'CAPABILITY_REVOKED', 'user', $2, $3::jsonb)`,
        [revokedBy, userId, JSON.stringify({ capability })],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async hasCapability(userId: string, capability: Capability): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM user_capability_grants
       WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [userId, capability],
    );
    return result.rowCount === 1;
  }

  async grantTool(userId: string, toolName: ToolName, grantedBy: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO user_tool_grants (user_id, tool_name, granted_by) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, tool_name) DO UPDATE
         SET granted_by = EXCLUDED.granted_by, granted_at = now(), expires_at = NULL, revoked_at = NULL`,
        [userId, toolName, grantedBy],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'TOOL_GRANTED', 'user', $2, $3::jsonb)`,
        [grantedBy, userId, JSON.stringify({ toolName })],
      );
    });
  }

  async revokeTool(userId: string, toolName: ToolName, revokedBy: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        'UPDATE user_tool_grants SET revoked_at = now() WHERE user_id = $1 AND tool_name = $2 AND revoked_at IS NULL',
        [userId, toolName],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'TOOL_REVOKED', 'user', $2, $3::jsonb)`,
        [revokedBy, userId, JSON.stringify({ toolName })],
      );
    });
  }

  async hasToolGrant(userId: string, toolName: ToolName): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM user_tool_grants
       WHERE user_id = $1 AND tool_name = $2 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > now())`,
      [userId, toolName],
    );
    return result.rowCount === 1;
  }

  async consumeToolUsage(
    userId: string,
    toolName: ToolName,
    callsPerMinute: number,
    callsPerDay: number,
  ): Promise<ToolUsageDecision> {
    if (!Number.isSafeInteger(callsPerMinute) || callsPerMinute < 1 || !Number.isSafeInteger(callsPerDay) || callsPerDay < callsPerMinute) {
      throw new Error('Invalid server-side tool usage limits.');
    }
    const consumed = await this.pool.query(
      `INSERT INTO user_tool_usage
         (user_id, tool_name, minute_bucket, minute_count, day_bucket, day_count, updated_at)
       VALUES ($1, $2, date_trunc('minute', now()), 1, (now() AT TIME ZONE 'UTC')::date, 1, now())
       ON CONFLICT (user_id, tool_name) DO UPDATE SET
         minute_bucket = EXCLUDED.minute_bucket,
         minute_count = CASE WHEN user_tool_usage.minute_bucket = EXCLUDED.minute_bucket
           THEN user_tool_usage.minute_count + 1 ELSE 1 END,
         day_bucket = EXCLUDED.day_bucket,
         day_count = CASE WHEN user_tool_usage.day_bucket = EXCLUDED.day_bucket
           THEN user_tool_usage.day_count + 1 ELSE 1 END,
         updated_at = now()
       WHERE (user_tool_usage.minute_bucket <> EXCLUDED.minute_bucket OR user_tool_usage.minute_count < $3)
         AND (user_tool_usage.day_bucket <> EXCLUDED.day_bucket OR user_tool_usage.day_count < $4)
       RETURNING minute_count, day_count`,
      [userId, toolName, callsPerMinute, callsPerDay],
    );
    if (consumed.rowCount === 1) return 'ALLOWED';

    const current = await this.pool.query(
      `SELECT minute_bucket = date_trunc('minute', now()) AND minute_count >= $3 AS minute_limited,
              day_bucket = (now() AT TIME ZONE 'UTC')::date AND day_count >= $4 AS day_limited
       FROM user_tool_usage WHERE user_id = $1 AND tool_name = $2`,
      [userId, toolName, callsPerMinute, callsPerDay],
    );
    const row = current.rows[0];
    if (row?.day_limited === true) return 'DAILY_LIMIT';
    return 'MINUTE_LIMIT';
  }

  async listActiveToolGrants(userId: string): Promise<Array<{ toolName: ToolName; grantedAt: string; expiresAt: string | null }>> {
    const result = await this.pool.query(
      `SELECT tool_name, granted_at, expires_at FROM user_tool_grants
       WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       ORDER BY tool_name`,
      [userId],
    );
    return result.rows.map((row) => ({
      toolName: row.tool_name,
      grantedAt: new Date(row.granted_at).toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    }));
  }

  async writeAudit(input: { actorUserId: string | null; action: string; resourceType: string; resourceId: string | null; details: Record<string, unknown> }): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [input.actorUserId, input.action, input.resourceType, input.resourceId, JSON.stringify(input.details)],
    );
  }

  async createFile(input: Omit<EncryptedFileRecord, 'createdAt'>): Promise<FileMetadata> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO user_files
           (id, user_id, filename, content_type, byte_length, sha256, key_version, ciphertext, nonce, auth_tag, wrapped_key, wrap_nonce, wrap_auth_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id, filename, content_type, byte_length, sha256, created_at`,
        [input.fileId, input.userId, input.filename, input.contentType, input.byteLength, input.sha256, input.keyVersion,
          input.ciphertext, input.nonce, input.authTag, input.wrappedKey, input.wrapNonce, input.wrapAuthTag],
      );
      const row = result.rows[0];
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'FILE_UPLOADED', 'file', $2, $3::jsonb)`,
        [input.userId, input.fileId, JSON.stringify({ contentType: input.contentType, byteLength: input.byteLength })],
      );
      return {
        fileId: row.id,
        filename: row.filename,
        contentType: row.content_type,
        byteLength: row.byte_length,
        sha256: row.sha256,
        createdAt: new Date(row.created_at).toISOString(),
      };
    });
  }

  async findFileForOwner(fileId: string, userId: string): Promise<EncryptedFileRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, filename, content_type, byte_length, sha256, key_version,
              ciphertext, nonce, auth_tag, wrapped_key, wrap_nonce, wrap_auth_tag, created_at
       FROM user_files WHERE id = $1 AND user_id = $2`,
      [fileId, userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      fileId: row.id,
      userId: row.user_id,
      filename: row.filename,
      contentType: row.content_type,
      byteLength: row.byte_length,
      sha256: row.sha256,
      keyVersion: row.key_version,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
      wrappedKey: row.wrapped_key,
      wrapNonce: row.wrap_nonce,
      wrapAuthTag: row.wrap_auth_tag,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async deleteFileForOwner(fileId: string, userId: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        'DELETE FROM user_files WHERE id = $1 AND user_id = $2 RETURNING id, content_type, byte_length',
        [fileId, userId],
      );
      const row = result.rows[0];
      if (!row) return false;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'FILE_DELETED', 'file', $2, $3::jsonb)`,
        [userId, fileId, JSON.stringify({ contentType: row.content_type, byteLength: row.byte_length })],
      );
      return true;
    });
  }

  async createTask(input: { userId: string; capability: TaskCapability; taskInput: TaskInput }): Promise<{ id: string; createdAt: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const task = await client.query(
        `INSERT INTO tasks (user_id, type, status, input) VALUES ($1, $2, 'QUEUED', $3::jsonb)
         RETURNING id, created_at`,
        [input.userId, input.capability, JSON.stringify(input.taskInput)],
      );
      await client.query("INSERT INTO task_steps (task_id, name, status) VALUES ($1, 'accepted', 'COMPLETED')", [task.rows[0].id]);
      await client.query('INSERT INTO task_outbox (task_id) VALUES ($1)', [task.rows[0].id]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'TASK_ACCEPTED', 'task', $2, $3::jsonb)`,
        [input.userId, task.rows[0].id, JSON.stringify({ capability: input.capability })],
      );
      const row = task.rows[0];
      await client.query(
        `SELECT pg_notify('lazaynova_task_events', $1)`,
        [JSON.stringify({ taskId: row.id, userId: input.userId, status: 'QUEUED', changedAt: new Date(row.created_at).toISOString() })],
      );
      await client.query('COMMIT');
      return { id: row.id, createdAt: new Date(row.created_at).toISOString() };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findTask(taskId: string, userId: string): Promise<TaskRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, type, status, priority, created_at, started_at, completed_at, input, result, error, verification
       FROM tasks WHERE id = $1 AND user_id = $2`,
      [taskId, userId],
    );
    return result.rows[0] ? this.toTaskRecord(result.rows[0]) : null;
  }

  async cancelTask(taskId: string, userId: string): Promise<'CANCELLED' | 'ALREADY_CANCELLED' | 'NOT_FOUND' | 'NOT_CANCELLABLE'> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await client.query(
        `UPDATE tasks SET status = 'CANCELLED', completed_at = now(), updated_at = now(),
             execution_lease_owner = NULL, execution_lease_expires_at = NULL
         WHERE id = $1 AND user_id = $2
           AND status IN ('QUEUED', 'PLANNING', 'RUNNING', 'WAITING', 'VERIFYING')
         RETURNING updated_at`,
        [taskId, userId],
      );
      if (cancelled.rowCount === 1) {
        const changedAt = new Date(cancelled.rows[0].updated_at).toISOString();
        await client.query("INSERT INTO task_steps (task_id, name, status) VALUES ($1, 'cancelled', 'CANCELLED')", [taskId]);
        await client.query("INSERT INTO task_logs (task_id, level, message) VALUES ($1, 'INFO', 'Task cancelled by its owner.')", [taskId]);
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'TASK_CANCELLED', 'task', $2, '{}'::jsonb)`,
          [userId, taskId],
        );
        await client.query(
          `SELECT pg_notify('lazaynova_task_events', $1)`,
          [JSON.stringify({ taskId, userId, status: 'CANCELLED', changedAt })],
        );
        return 'CANCELLED';
      }

      const existing = await client.query('SELECT status FROM tasks WHERE id = $1 AND user_id = $2', [taskId, userId]);
      if (!existing.rows[0]) return 'NOT_FOUND';
      return existing.rows[0].status === 'CANCELLED' ? 'ALREADY_CANCELLED' : 'NOT_CANCELLABLE';
    });
  }

  async findTaskForWorker(taskId: string): Promise<TaskRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, type, status, priority, created_at, started_at, completed_at, input, result, error, verification
       FROM tasks WHERE id = $1`,
      [taskId],
    );
    return result.rows[0] ? this.toTaskRecord(result.rows[0]) : null;
  }

  async findTaskExecutionState(taskId: string): Promise<{ userId: string; status: TaskStatus } | null> {
    const result = await this.pool.query('SELECT user_id, status FROM tasks WHERE id = $1', [taskId]);
    const row = result.rows[0];
    return row ? { userId: row.user_id, status: row.status } : null;
  }

  async claimTaskExecution(taskId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `WITH candidate AS (
           SELECT id, status AS previous_status FROM tasks
           WHERE id = $1
             AND status IN ('QUEUED', 'PLANNING', 'RUNNING', 'WAITING', 'VERIFYING')
             AND (execution_lease_owner IS NULL OR execution_lease_expires_at IS NULL OR execution_lease_expires_at <= now() OR execution_lease_owner = $2)
           FOR UPDATE
         )
         UPDATE tasks AS task
         SET status = 'PLANNING',
             started_at = COALESCE(task.started_at, now()),
             updated_at = now(),
             execution_lease_owner = $2,
             execution_lease_expires_at = now() + (GREATEST($3, 1000) * interval '1 millisecond')
         FROM candidate
         WHERE task.id = candidate.id
         RETURNING task.user_id, task.updated_at, candidate.previous_status`,
        [taskId, leaseOwner, leaseMilliseconds],
      );
      if (result.rowCount !== 1) return false;
      const row = result.rows[0];
      await client.query("INSERT INTO task_steps (task_id, name, status) VALUES ($1, 'planning', 'PLANNING')", [taskId]);
      if (row.previous_status !== 'QUEUED') {
        await client.query(
          "INSERT INTO task_logs (task_id, level, message) VALUES ($1, 'WARN', 'WORKER_RECOVERY: resuming persisted execution plan')",
          [taskId],
        );
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES (NULL, 'TASK_WORKER_RECOVERED', 'task', $1, $2::jsonb)`,
          [taskId, JSON.stringify({ previousStatus: row.previous_status })],
        );
      }
      await client.query(
        `SELECT pg_notify('lazaynova_task_events', $1)`,
        [JSON.stringify({ taskId, userId: row.user_id, status: 'PLANNING', changedAt: new Date(row.updated_at).toISOString() })],
      );
      return true;
    });
  }

  async renewTaskExecutionLease(taskId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tasks SET execution_lease_expires_at = now() + (GREATEST($3, 1000) * interval '1 millisecond')
       WHERE id = $1 AND execution_lease_owner = $2
         AND status IN ('PLANNING', 'RUNNING', 'WAITING', 'VERIFYING')`,
      [taskId, leaseOwner, leaseMilliseconds],
    );
    return result.rowCount === 1;
  }

  async releaseTaskExecutionLease(taskId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET execution_lease_owner = NULL, execution_lease_expires_at = NULL
       WHERE id = $1 AND execution_lease_owner = $2`,
      [taskId, leaseOwner],
    );
  }

  async transitionTask(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    details: { error?: { code: string; message: string }; result?: unknown; verification?: VerificationResult; leaseOwner?: string } = {},
  ): Promise<boolean> {
    assertTransition(from, to);
    const sets = ['status = $3', 'updated_at = now()'];
    const values: unknown[] = [taskId, from, to];
    if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED' || to === 'QUEUED') {
      sets.push('execution_lease_owner = NULL', 'execution_lease_expires_at = NULL');
    }
    if (to === 'RUNNING') sets.push('started_at = COALESCE(started_at, now())');
    if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED') sets.push('completed_at = now()');
    if (details.error !== undefined) { values.push(JSON.stringify(details.error)); sets.push(`error = $${values.length}::jsonb`); }
    if (details.result !== undefined) { values.push(JSON.stringify(details.result)); sets.push(`result = $${values.length}::jsonb`); }
    if (details.verification !== undefined) { values.push(JSON.stringify(details.verification)); sets.push(`verification = $${values.length}::jsonb`); }
    let leaseCondition = '';
    if (details.leaseOwner !== undefined) {
      values.push(details.leaseOwner);
      leaseCondition = ` AND execution_lease_owner = $${values.length}`;
    }
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 AND status = $2${leaseCondition}
         RETURNING user_id, status, updated_at, error->>'code' AS error_code`,
        values,
      );
      if (result.rowCount !== 1) return false;
      await client.query('INSERT INTO task_steps (task_id, name, status) VALUES ($1, $2, $3)', [taskId, to.toLowerCase(), to]);
      const row = result.rows[0];
      await client.query(
        `SELECT pg_notify('lazaynova_task_events', $1)`,
        [JSON.stringify({
          taskId,
          userId: row.user_id,
          status: row.status,
          changedAt: new Date(row.updated_at).toISOString(),
          ...(row.error_code ? { errorCode: row.error_code } : {}),
        })],
      );
      return true;
    });
  }

  async appendTaskLog(taskId: string, level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
    await this.pool.query('INSERT INTO task_logs (task_id, level, message) VALUES ($1, $2, $3)', [taskId, level, message.slice(0, 4_000)]);
  }

  async saveExecutionPlan(taskId: string, plan: AgentPlan, planHash: string): Promise<void> {
    const computedHash = hashAgentPlan(plan);
    if (computedHash !== planHash) throw new HttpError(400, 'TASK_PLAN_HASH_INVALID', 'The execution plan failed its integrity check.');
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO task_execution_plans (task_id, plan, plan_hash) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (task_id) DO NOTHING`,
        [taskId, JSON.stringify(plan), planHash],
      );
      const saved = await client.query('SELECT plan_hash FROM task_execution_plans WHERE task_id = $1 FOR UPDATE', [taskId]);
      if (!saved.rows[0] || saved.rows[0].plan_hash !== planHash) {
        throw new HttpError(409, 'TASK_PLAN_ALREADY_EXISTS', 'A different execution plan is already stored for this task.');
      }
      for (const node of plan.graph.nodes) {
        await client.query(
          `INSERT INTO task_graph_nodes (task_id, node_id, capability, operation, goal, depends_on, status)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'PENDING') ON CONFLICT (task_id, node_id) DO NOTHING`,
          [taskId, node.id, node.capability, node.operation, node.goal, JSON.stringify(node.dependsOn)],
        );
      }
    });
  }

  async loadExecutionPlan(taskId: string): Promise<TaskGraphSnapshot | null> {
    const planResult = await this.pool.query('SELECT plan, plan_hash FROM task_execution_plans WHERE task_id = $1', [taskId]);
    const planRow = planResult.rows[0];
    if (!planRow) return null;
    const nodeResult = await this.pool.query(
      'SELECT node_id, status, attempts, result FROM task_graph_nodes WHERE task_id = $1 ORDER BY created_at, node_id',
      [taskId],
    );
    return {
      plan: planRow.plan as AgentPlan,
      planHash: String(planRow.plan_hash).trim(),
      nodes: nodeResult.rows.map((row) => ({
        id: row.node_id,
        status: row.status as GraphNodeStatus,
        attempts: Number(row.attempts),
        result: row.result as AgentResult | null,
      })),
    };
  }

  async startGraphNode(taskId: string, nodeId: string): Promise<number | null> {
    const result = await this.pool.query(
      `UPDATE task_graph_nodes SET status = 'RUNNING', attempts = attempts + 1,
         started_at = COALESCE(started_at, now()), updated_at = now(), last_error_code = NULL
       WHERE task_id = $1 AND node_id = $2 AND status IN ('PENDING', 'RUNNING', 'FAILED') AND attempts < 3
       RETURNING attempts`,
      [taskId, nodeId],
    );
    return result.rows[0] ? Number(result.rows[0].attempts) : null;
  }

  async completeGraphNode(taskId: string, nodeId: string, result: AgentResult): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE task_graph_nodes SET status = 'COMPLETED', result = $3::jsonb, completed_at = now(), updated_at = now()
       WHERE task_id = $1 AND node_id = $2 AND status = 'RUNNING'`,
      [taskId, nodeId, JSON.stringify(result)],
    );
    if (updated.rowCount !== 1) throw new HttpError(409, 'TASK_GRAPH_NODE_STATE_CONFLICT', 'The execution step could not be checkpointed.');
  }

  async failGraphNode(taskId: string, nodeId: string, safeCode: string): Promise<void> {
    const updated = await this.pool.query(
      `UPDATE task_graph_nodes SET status = 'FAILED', last_error_code = $3, updated_at = now()
       WHERE task_id = $1 AND node_id = $2 AND status = 'RUNNING'`,
      [taskId, nodeId, safeCode.slice(0, 64)],
    );
    if (updated.rowCount !== 1) throw new HttpError(409, 'TASK_GRAPH_NODE_STATE_CONFLICT', 'The execution step state could not be updated.');
  }

  async blockGraphNode(taskId: string, nodeId: string): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE task_graph_nodes SET status = 'BLOCKED', updated_at = now()
       WHERE task_id = $1 AND node_id = $2 AND status = 'PENDING'`,
      [taskId, nodeId],
    );
    return updated.rowCount === 1;
  }

  async persistEvidenceChain(taskId: string, evidence: AgentResult['evidence']): Promise<void> {
    if (evidence.length > 256) throw new HttpError(413, 'EVIDENCE_CHAIN_TOO_LARGE', 'The evidence chain exceeds the supported item limit.');
    await withTransaction(this.pool, async (client) => {
      await client.query('DELETE FROM task_evidence_chain WHERE task_id = $1', [taskId]);
      for (let index = 0; index < evidence.length; index += 1) {
        const item = evidence[index]!;
        const chain = item.chain as { sequence?: number; previousHash?: string; itemHash?: string; chainHash?: string } | undefined;
        await client.query(
          `INSERT INTO task_evidence_chain (task_id, sequence, kind, evidence, previous_hash, item_hash, chain_hash)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
          [taskId, index + 1, item.kind.slice(0, 64), JSON.stringify(item), chain?.previousHash ?? null,
            chain?.itemHash ?? null, chain?.chainHash ?? (typeof item.rootHash === 'string' ? item.rootHash : null)],
        );
      }
    });
  }

  private async toTaskRecord(row: Record<string, any>): Promise<TaskRecord> {
    const [steps, logs, plan, graphNodes, evidenceRoot] = await Promise.all([
      this.pool.query('SELECT id, name, status, created_at FROM task_steps WHERE task_id = $1 ORDER BY created_at, id', [row.id]),
      this.pool.query('SELECT id, level, message, created_at FROM task_logs WHERE task_id = $1 ORDER BY created_at, id', [row.id]),
      this.pool.query('SELECT plan FROM task_execution_plans WHERE task_id = $1', [row.id]),
      this.pool.query('SELECT node_id, status, attempts FROM task_graph_nodes WHERE task_id = $1 ORDER BY created_at, node_id', [row.id]),
      this.pool.query('SELECT chain_hash FROM task_evidence_chain WHERE task_id = $1 ORDER BY sequence DESC LIMIT 1', [row.id]),
    ]);
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      input: row.input,
      steps: steps.rows.map((item) => ({ id: item.id, name: item.name, status: item.status, createdAt: new Date(item.created_at).toISOString() })),
      logs: logs.rows.map((item) => ({ id: item.id, level: item.level, message: item.message, createdAt: new Date(item.created_at).toISOString() })),
      result: row.result,
      error: row.error,
      verification: row.verification,
      executionPlan: plan.rows[0]?.plan?.graph ?? null,
      graphNodes: graphNodes.rows.map((item) => ({ id: item.node_id, status: item.status, attempts: Number(item.attempts) })),
      evidenceChainRoot: evidenceRoot.rows[0]?.chain_hash ?? null,
    };
  }
}

export async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
