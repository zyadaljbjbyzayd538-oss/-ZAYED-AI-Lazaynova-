import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresWorkflowRunRepository } from '../src/infrastructure/postgres-workflow-runs.js';
import type { Pool, PoolClient } from 'pg';

const ownerId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const workflowId = '4412c44b-8119-488e-85c0-d1b035f6857f';
const runId = '5412c44b-8119-488e-85c0-d1b035f6857f';
const at = new Date('2026-09-30T00:00:00.000Z');
const step = { id: 'draft', capability: 'WRITING' as const, prompt: 'Private step.', dependsOn: [], approvalRequired: true };

function makePool(handler: (sql: string, values?: unknown[]) => { rows?: Array<Record<string, unknown>>; rowCount?: number }) {
  const statements: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      statements.push({ sql, values });
      const result = handler(sql, values);
      return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
    },
    release() {},
  } as unknown as PoolClient;
  const pool = { async connect() { return client; }, async query(sql: string, values?: unknown[]) {
    statements.push({ sql, values }); const result = handler(sql, values); return { rows: result.rows ?? [], rowCount: result.rowCount ?? result.rows?.length ?? 0 };
  } } as unknown as Pool;
  return { pool, statements };
}

function workflowRow() {
  return {
    id: runId, owner_user_id: ownerId, workflow_id: workflowId, definition_version: 1, workflow_name: 'approval-flow',
    status: 'QUEUED', input: { text: 'Private task prompt.', attachments: [] }, result: null, evidence: null, error_code: null,
    cancel_requested_at: null, created_at: at, started_at: null, completed_at: null,
  };
}

test('workflow run creation snapshots bounded inputs and atomically stores steps, outbox, and content-free audit', async () => {
  const pool = makePool((sql) => sql.includes('INSERT INTO workflow_runs') ? { rows: [workflowRow()] } : { rowCount: 1 });
  const repository = new PostgresWorkflowRunRepository(pool.pool);
  const run = await repository.createWorkflowRun({
    ownerId, workflowId, workflowName: 'approval-flow', version: 1,
    input: { text: 'Private task prompt.', attachments: [] }, steps: [step],
  });
  assert.equal(run.runId, runId);
  assert.equal(run.status, 'QUEUED');
  assert.equal(run.steps[0]?.status, 'PENDING');
  assert.deepEqual(pool.statements.map((item) => item.sql).filter((sql) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'COMMIT']);
  assert.ok(pool.statements.some((item) => item.sql.includes('INSERT INTO workflow_run_steps')));
  assert.ok(pool.statements.some((item) => item.sql.includes('INSERT INTO workflow_run_outbox')));
  const audit = pool.statements.find((item) => item.sql.includes('WORKFLOW_RUN_ACCEPTED'));
  assert.ok(audit);
  assert.equal(JSON.stringify(audit.values).includes('Private task prompt.'), false);
  assert.match(pool.statements[1]?.sql ?? '', /d\.owner_user_id = \$1/);
});

test('workflow run reads validate stored step snapshots and scope lookup by owner', async () => {
  const pool = makePool((sql, values) => {
    if (sql.includes('FROM workflow_runs WHERE id = $1 AND owner_user_id = $2')) return values?.[1] === ownerId ? { rows: [workflowRow()] } : { rows: [] };
    if (sql.includes('FROM workflow_run_steps')) return { rows: [{
      definition: step, status: 'PENDING', attempts: 0, result: null, evidence: null, error_code: null, approved_by: null, approved_at: null,
    }] };
    return { rowCount: 1 };
  });
  const repository = new PostgresWorkflowRunRepository(pool.pool);
  const run = await repository.findWorkflowRun(runId, ownerId);
  assert.equal(run?.workflowName, 'approval-flow');
  assert.equal(run?.steps[0]?.prompt, 'Private step.');
  assert.equal(run?.input.text, 'Private task prompt.');
  const missing = await repository.findWorkflowRun(runId, '3512c44b-8119-488e-85c0-d1b035f6857f');
  assert.equal(missing, null);
});

test('workflow approval changes the run and writes its resume outbox and audit atomically', async () => {
  const pool = makePool((sql) => {
    if (sql.includes('SELECT id, status FROM workflow_runs')) return { rows: [{ id: runId, status: 'WAITING_APPROVAL' }] };
    if (sql.includes('UPDATE workflow_run_steps')) return { rowCount: 1 };
    return { rowCount: 1 };
  });
  const repository = new PostgresWorkflowRunRepository(pool.pool);
  assert.equal(await repository.decideWorkflowApproval(ownerId, runId, 'draft', 'APPROVE'), 'APPROVED');
  const statements = pool.statements.map((item) => item.sql);
  assert.ok(statements.indexOf('BEGIN') < statements.findIndex((sql) => sql.includes('FOR UPDATE')));
  assert.ok(statements.some((sql) => sql.includes("SET status = 'QUEUED'")));
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO workflow_run_outbox')));
  assert.ok(statements.some((sql) => sql.includes('WORKFLOW_STEP_APPROVED')));
  assert.equal(statements.at(-1), 'COMMIT');
});
