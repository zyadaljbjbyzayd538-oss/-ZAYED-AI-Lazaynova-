import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { PostgresTaskEventSource } from '../src/infrastructure/postgres-task-events.js';

class FakePostgresClient extends EventEmitter {
  readonly statements: string[] = [];
  released = false;

  async query(statement: string): Promise<unknown> {
    this.statements.push(statement);
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

test('PostgreSQL task event adapter listens once, filters by owner, validates payloads, and unsubscribes', async () => {
  const client = new FakePostgresClient();
  const pool = { async connect() { return client as unknown as PoolClient; } } as unknown as Pool;
  const source = new PostgresTaskEventSource(pool);
  const taskId = '3512c44b-8119-488e-85c0-d1b035f6857f';
  const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
  const received: unknown[] = [];

  await source.start();
  const unsubscribe = source.subscribe(taskId, userId, (event) => received.push(event));
  const publish = (payload: string) => client.emit('notification', { channel: 'lazaynova_task_events', payload });
  publish('not-json');
  publish(JSON.stringify({ taskId, userId: 'another-user', status: 'RUNNING', changedAt: '2026-09-29T00:00:00.000Z' }));
  publish(JSON.stringify({ taskId, userId, status: 'UNKNOWN', changedAt: '2026-09-29T00:00:00.000Z' }));
  publish(JSON.stringify({ taskId, userId, status: 'RUNNING', changedAt: '2026-09-29T00:00:00.000Z' }));

  assert.deepEqual(received, [{ taskId, userId, status: 'RUNNING', changedAt: '2026-09-29T00:00:00.000Z' }]);
  unsubscribe();
  publish(JSON.stringify({ taskId, userId, status: 'VERIFYING', changedAt: '2026-09-29T00:00:01.000Z' }));
  assert.equal(received.length, 1);
  await source.close();
  assert.deepEqual(client.statements, ['LISTEN lazaynova_task_events', 'UNLISTEN lazaynova_task_events']);
  assert.equal(client.released, true);
});
