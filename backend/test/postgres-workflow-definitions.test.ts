import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresWorkflowDefinitionRepository } from '../src/infrastructure/postgres-workflow-definitions.js';
import type { Pool, PoolClient } from 'pg';

const ownerId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const workflowId = '4412c44b-8119-488e-85c0-d1b035f6857f';
const prompt = 'Review primary sources and prepare a factual summary.';
const steps = [{
  id: 'research', capability: 'WEB_RESEARCH' as const, prompt, dependsOn: [], approvalRequired: true,
}];
const at = new Date('2026-09-30T00:00:00.000Z');

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };
function fakePool(results: Array<QueryResult | Error>) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const run = async (sql: string, values?: unknown[]): Promise<QueryResult> => {
    statements.push({ sql, ...(values ? { values } : {}) });
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next ?? { rows: [], rowCount: 0 };
  };
  const client = { query: run, release() {} } as unknown as PoolClient;
  const pool = { query: run, async connect() { return client; } } as unknown as Pool;
  return { pool, statements };
}

test('workflow definition and first version are inserted with an atomic content-free audit record', async () => {
  const { pool, statements } = fakePool([
    { rows: [], rowCount: 0 },
    { rows: [{ id: workflowId, name: 'weekly-research', latest_version: 1, created_at: at, updated_at: at }], rowCount: 1 },
    { rows: [{ created_at: at }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = new PostgresWorkflowDefinitionRepository(pool);
  const created = await repository.createWorkflowDefinition(ownerId, { name: 'weekly-research', steps });
  assert.equal(created.workflowId, workflowId);
  assert.equal(created.version, 1);
  assert.equal(created.steps[0]?.prompt, prompt);
  assert.equal(statements[0]?.sql, 'BEGIN');
  assert.match(statements[1]!.sql, /INSERT INTO workflow_definitions/);
  assert.match(statements[2]!.sql, /INSERT INTO workflow_definition_versions/);
  assert.deepEqual(statements[2]!.values, [workflowId, 1, JSON.stringify({ steps }), ownerId]);
  assert.match(statements[3]!.sql, /WORKFLOW_DEFINITION_VERSION_CREATED/);
  assert.equal(JSON.stringify(statements[3]!.values).includes(prompt), false);
  assert.equal(statements.at(-1)?.sql, 'COMMIT');
});

test('workflow version increments atomically only for its owner and returns not-found on owner mismatch', async () => {
  const { pool, statements } = fakePool([
    { rows: [], rowCount: 0 },
    { rows: [{ id: workflowId, name: 'weekly-research', latest_version: 2, created_at: at, updated_at: at }], rowCount: 1 },
    { rows: [{ created_at: at }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = new PostgresWorkflowDefinitionRepository(pool);
  const version = await repository.createWorkflowDefinitionVersion(ownerId, workflowId, { steps });
  assert.equal(version?.version, 2);
  assert.equal(statements[0]?.sql, 'BEGIN');
  assert.deepEqual(statements[1]!.values, [workflowId, ownerId]);
  assert.match(statements[1]!.sql, /latest_version = latest_version \+ 1/);
  const missing = await repository.createWorkflowDefinitionVersion('3512c44b-8119-488e-85c0-d1b035f6857f', workflowId, { steps });
  assert.equal(missing, null);
  assert.equal(statements[5]?.sql, 'BEGIN');
  assert.deepEqual(statements[6]!.values, [workflowId, '3512c44b-8119-488e-85c0-d1b035f6857f']);
  assert.equal(statements[7]?.sql, 'COMMIT');
});

test('workflow version transaction rolls back if its audit write fails', async () => {
  const { pool, statements } = fakePool([
    { rows: [], rowCount: 0 },
    { rows: [{ id: workflowId, name: 'weekly-research', latest_version: 1, created_at: at, updated_at: at }], rowCount: 1 },
    { rows: [{ created_at: at }], rowCount: 1 },
    new Error('audit storage unavailable'),
    { rows: [], rowCount: 0 },
  ]);
  const repository = new PostgresWorkflowDefinitionRepository(pool);
  await assert.rejects(() => repository.createWorkflowDefinition(ownerId, { name: 'weekly-research', steps }), /audit storage unavailable/);
  assert.equal(statements.at(-1)?.sql, 'ROLLBACK');
});

test('workflow reads are always scoped to owner and selected version', async () => {
  const { pool, statements } = fakePool([
    { rows: [{ id: workflowId, name: 'weekly-research', version: 3, definition: { steps }, created_at: at }], rowCount: 1 },
    { rows: [], rowCount: 0 },
  ]);
  const repository = new PostgresWorkflowDefinitionRepository(pool);
  const exact = await repository.findWorkflowDefinitionVersion(ownerId, workflowId, 3);
  assert.equal(exact?.version, 3);
  assert.deepEqual(statements[0]!.values, [ownerId, workflowId, 3]);
  assert.match(statements[0]!.sql, /d\.owner_user_id = \$1 AND d\.id = \$2 AND v\.version = \$3/);
  const absent = await repository.findLatestWorkflowDefinition(ownerId, workflowId);
  assert.equal(absent, null);
  assert.deepEqual(statements[1]!.values, [ownerId, workflowId]);
});
