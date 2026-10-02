import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepositories } from '../src/infrastructure/postgres.js';
import type { Pool, PoolClient } from 'pg';

const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const adminId = '3512c44b-8119-488e-85c0-d1b035f6857f';

class FakeClient {
  readonly statements: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;
  async query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.statements.push({ sql, ...(values ? { values } : {}) });
    return { rows: [], rowCount: 1 };
  }
  release(): void { this.released = true; }
}

function createRepositories(client = new FakeClient(), options: {
  queryResult?: { rows: Array<Record<string, unknown>>; rowCount: number };
} = {}) {
  const pool = {
    async connect() { return client as unknown as PoolClient; },
    async query(sql: string, values?: unknown[]) {
      client.statements.push({ sql, ...(values ? { values } : {}) });
      return options.queryResult ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { repositories: new PostgresRepositories(pool), client };
}

test('tool grant and revoke changes are transactional and audited without exposing user input', async () => {
  const { repositories, client } = createRepositories();
  await repositories.grantTool(userId, 'web.search', adminId);
  assert.equal(client.statements[0]?.sql, 'BEGIN');
  const grant = client.statements.find(({ sql }) => sql.includes('INSERT INTO user_tool_grants'));
  assert.ok(grant);
  assert.match(grant.sql, /ON CONFLICT \(user_id, tool_name\) DO UPDATE/);
  assert.deepEqual(grant.values, [userId, 'web.search', adminId]);
  assert.ok(client.statements.some(({ sql, values }) => sql.includes("'TOOL_GRANTED'") && values?.[0] === adminId));
  assert.equal(client.statements.at(-1)?.sql, 'COMMIT');

  client.statements.length = 0;
  await repositories.revokeTool(userId, 'web.search', adminId);
  assert.equal(client.statements[0]?.sql, 'BEGIN');
  assert.ok(client.statements.some(({ sql, values }) => sql.includes('UPDATE user_tool_grants') && values?.[0] === userId));
  assert.ok(client.statements.some(({ sql }) => sql.includes("'TOOL_REVOKED'")));
  assert.equal(client.statements.at(-1)?.sql, 'COMMIT');
  assert.equal(client.released, true);
});

test('tool grant lookup requires an active, non-expired grant', async () => {
  const { repositories, client } = createRepositories(undefined, { queryResult: { rows: [{ '?column?': 1 }], rowCount: 1 } });
  assert.equal(await repositories.hasToolGrant(userId, 'file.read_text'), true);
  const query = client.statements[0];
  assert.ok(query);
  assert.match(query.sql, /revoked_at IS NULL/);
  assert.match(query.sql, /expires_at IS NULL OR expires_at > now\(\)/);
  assert.deepEqual(query.values, [userId, 'file.read_text']);
});

test('active tool grant listing returns only safe identifiers and ISO grant times', async () => {
  const { repositories } = createRepositories(undefined, {
    queryResult: { rows: [{ tool_name: 'web.search', granted_at: '2026-09-30T00:00:00.000Z', expires_at: null }], rowCount: 1 },
  });
  assert.deepEqual(await repositories.listActiveToolGrants(userId), [{
    toolName: 'web.search', grantedAt: '2026-09-30T00:00:00.000Z', expiresAt: null,
  }]);
});
