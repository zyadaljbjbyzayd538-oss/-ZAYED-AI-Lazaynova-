import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepositories } from '../src/infrastructure/postgres.js';
import type { Pool, PoolClient } from 'pg';

const taskId = '3512c44b-8119-488e-85c0-d1b035f6857f';
const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';

class FakeClient {
  readonly statements: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;
  updateRowCount = 1;
  existingStatus: string | null = null;

  async query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.statements.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes("UPDATE tasks SET status = 'CANCELLED'")) {
      return { rows: this.updateRowCount ? [{ updated_at: '2026-09-30T00:00:00.000Z' }] : [], rowCount: this.updateRowCount };
    }
    if (sql.includes('SELECT status FROM tasks')) {
      return { rows: this.existingStatus ? [{ status: this.existingStatus }] : [], rowCount: this.existingStatus ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void { this.released = true; }
}

function buildRepository(client: FakeClient): PostgresRepositories {
  const pool = { async connect() { return client as unknown as PoolClient; } } as unknown as Pool;
  return new PostgresRepositories(pool);
}

test('PostgreSQL cancellation atomically clears the lease, audits the owner, and publishes terminal status', async () => {
  const client = new FakeClient();
  const repositories = buildRepository(client);
  assert.equal(await repositories.cancelTask(taskId, userId), 'CANCELLED');
  assert.equal(client.statements[0]?.sql, 'BEGIN');
  const update = client.statements.find(({ sql }) => sql.includes("UPDATE tasks SET status = 'CANCELLED'"));
  assert.ok(update);
  assert.match(update.sql, /WHERE id = \$1 AND user_id = \$2/);
  assert.match(update.sql, /status IN \('QUEUED', 'PLANNING', 'RUNNING', 'WAITING', 'VERIFYING'\)/);
  assert.match(update.sql, /execution_lease_owner = NULL/);
  assert.deepEqual(update.values, [taskId, userId]);
  assert.ok(client.statements.some(({ sql, values }) => sql.includes("'TASK_CANCELLED'") && values?.[0] === userId));
  assert.ok(client.statements.some(({ sql }) => sql.includes("pg_notify('lazaynova_task_events'")));
  assert.equal(client.statements.at(-1)?.sql, 'COMMIT');
  assert.equal(client.released, true);
});

test('PostgreSQL cancellation returns not found for unknown or non-owned task IDs', async () => {
  const client = new FakeClient();
  client.updateRowCount = 0;
  client.existingStatus = null;
  assert.equal(await buildRepository(client).cancelTask(taskId, userId), 'NOT_FOUND');
  assert.equal(client.statements.some(({ sql }) => sql.includes("'TASK_CANCELLED'")), false);
  assert.equal(client.statements.at(-1)?.sql, 'COMMIT');
});

test('PostgreSQL cancellation is idempotent for already cancelled tasks', async () => {
  const client = new FakeClient();
  client.updateRowCount = 0;
  client.existingStatus = 'CANCELLED';
  assert.equal(await buildRepository(client).cancelTask(taskId, userId), 'ALREADY_CANCELLED');
  assert.equal(client.statements.some(({ sql }) => sql.includes("'TASK_CANCELLED'")), false);
});

test('PostgreSQL cancellation does not rewrite completed or failed tasks', async () => {
  const client = new FakeClient();
  client.updateRowCount = 0;
  client.existingStatus = 'COMPLETED';
  assert.equal(await buildRepository(client).cancelTask(taskId, userId), 'NOT_CANCELLABLE');
  assert.equal(client.statements.some(({ sql }) => sql.includes("'TASK_CANCELLED'")), false);
});
