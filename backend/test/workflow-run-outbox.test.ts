import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowRunOutboxDispatcher, type WorkflowRunJob } from '../src/infrastructure/workflow-run-outbox.js';
import type { Pool, PoolClient } from 'pg';
import type { Queue } from 'bullmq';

function makeDispatcher(queueError?: Error) {
  const sql: string[] = [];
  const updates: Array<{ statement: string; values: unknown[] | undefined }> = [];
  let added: { name: string; data: WorkflowRunJob; options: Record<string, unknown> } | null = null;
  const client = {
    async query(statement: string, values?: unknown[]) {
      sql.push(statement);
      if (statement.includes('RETURNING o.id, o.workflow_run_id')) return { rows: [{ id: 'outbox-1', workflow_run_id: 'run-1' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = {
    async connect() { return client; },
    async query(statement: string, values?: unknown[]) { updates.push({ statement, values }); return { rows: [], rowCount: 1 }; },
  } as unknown as Pool;
  const queue = {
    async add(name: string, data: WorkflowRunJob, options: Record<string, unknown>) {
      if (queueError) throw queueError;
      added = { name, data, options };
      return {};
    },
  } as unknown as Queue<WorkflowRunJob>;
  return { dispatcher: new WorkflowRunOutboxDispatcher(pool, queue), sql, updates, get added() { return added; } };
}

test('workflow outbox dispatches a durable run job using the outbox id for idempotency', async () => {
  const fixture = makeDispatcher();
  assert.equal(await fixture.dispatcher.dispatchBatch(), 1);
  assert.equal(fixture.added?.name, 'execute-workflow-run');
  assert.deepEqual(fixture.added?.data, { workflowRunId: 'run-1' });
  assert.equal(fixture.added?.options.jobId, 'outbox-1');
  assert.ok(fixture.sql.includes('BEGIN'));
  assert.ok(fixture.sql.includes('COMMIT'));
  assert.match(fixture.updates[0]?.statement ?? '', /status = 'PUBLISHED'/);
});

test('workflow outbox safely requeues a failed Redis publication without leaking its error detail', async () => {
  const fixture = makeDispatcher(new Error('redis password and endpoint details'));
  assert.equal(await fixture.dispatcher.dispatchBatch(), 1);
  assert.equal(fixture.added, null);
  assert.match(fixture.updates[0]?.statement ?? '', /status = 'PENDING'/);
  assert.deepEqual(fixture.updates[0]?.values, ['outbox-1']);
  assert.equal((fixture.updates[0]?.statement ?? '').includes('redis password'), false);
});
