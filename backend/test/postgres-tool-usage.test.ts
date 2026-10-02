import test from 'node:test';
import assert from 'node:assert/strict';
import { PostgresRepositories } from '../src/infrastructure/postgres.js';
import type { Pool } from 'pg';

const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';

function buildRepositories(results: Array<{ rows: Array<Record<string, unknown>>; rowCount: number }>) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const pool = {
    async query(sql: string, values?: unknown[]) {
      statements.push({ sql, ...(values ? { values } : {}) });
      return results.shift() ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { repositories: new PostgresRepositories(pool), statements };
}

test('tool usage reservation atomically increments a per-user minute and UTC-day bucket', async () => {
  const { repositories, statements } = buildRepositories([{ rows: [{ minute_count: 1, day_count: 1 }], rowCount: 1 }]);
  assert.equal(await repositories.consumeToolUsage(userId, 'web.search', 20, 200), 'ALLOWED');
  assert.equal(statements.length, 1);
  assert.match(statements[0]!.sql, /INSERT INTO user_tool_usage/);
  assert.match(statements[0]!.sql, /ON CONFLICT \(user_id, tool_name\) DO UPDATE/);
  assert.match(statements[0]!.sql, /date_trunc\('minute', now\(\)\)/);
  assert.match(statements[0]!.sql, /AT TIME ZONE 'UTC'/);
  assert.match(statements[0]!.sql, /minute_count < \$3/);
  assert.match(statements[0]!.sql, /day_count < \$4/);
  assert.deepEqual(statements[0]!.values, [userId, 'web.search', 20, 200]);
});

test('tool usage reservation reports the minute limit without incrementing past it', async () => {
  const { repositories, statements } = buildRepositories([
    { rows: [], rowCount: 0 },
    { rows: [{ minute_limited: true, day_limited: false }], rowCount: 1 },
  ]);
  assert.equal(await repositories.consumeToolUsage(userId, 'web.search', 20, 200), 'MINUTE_LIMIT');
  assert.equal(statements.length, 2);
  assert.match(statements[1]!.sql, /SELECT minute_bucket = date_trunc/);
});

test('tool usage reservation reports the daily limit after checking current UTC counters', async () => {
  const { repositories, statements } = buildRepositories([
    { rows: [], rowCount: 0 },
    { rows: [{ minute_limited: false, day_limited: true }], rowCount: 1 },
  ]);
  assert.equal(await repositories.consumeToolUsage(userId, 'file.read_text', 30, 500), 'DAILY_LIMIT');
  assert.deepEqual(statements[0]!.values, [userId, 'file.read_text', 30, 500]);
});

test('tool usage status reads only the current UTC minute/day buckets and returns server reset boundaries', async () => {
  const { repositories, statements } = buildRepositories([{
    rows: [{
      used_this_minute: 7,
      minute_reset_at: new Date('2026-10-02T12:01:00.000Z'),
      used_today: 88,
      utc_day_reset_at: new Date('2026-10-03T00:00:00.000Z'),
      server_time: new Date('2026-10-02T12:00:30.000Z'),
    }],
    rowCount: 1,
  }]);
  assert.deepEqual(await repositories.getToolUsageStatus(userId, 'web.search', 20, 200), {
    callsPerMinute: 20,
    usedThisMinute: 7,
    minuteResetAt: '2026-10-02T12:01:00.000Z',
    callsPerDay: 200,
    usedToday: 88,
    utcDayResetAt: '2026-10-03T00:00:00.000Z',
    serverTime: '2026-10-02T12:00:30.000Z',
  });
  assert.match(statements[0]!.sql, /minute_bucket = date_trunc\('minute', now\(\)\)/);
  assert.match(statements[0]!.sql, /day_bucket = \(now\(\) AT TIME ZONE 'UTC'\)::date/);
  assert.match(statements[0]!.sql, /AT TIME ZONE 'UTC'/);
  assert.deepEqual(statements[0]!.values, [userId, 'web.search']);
});

test('tool usage status rejects invalid server limits', async () => {
  const { repositories, statements } = buildRepositories([]);
  await assert.rejects(() => repositories.getToolUsageStatus(userId, 'web.search', 0, 200), /invalid server-side tool usage limits/i);
  assert.equal(statements.length, 0);
});

test('tool usage rejects invalid operator limits instead of weakening the quota', async () => {
  const { repositories, statements } = buildRepositories([]);
  await assert.rejects(() => repositories.consumeToolUsage(userId, 'web.search', 0, 200), /invalid server-side tool usage limits/i);
  assert.equal(statements.length, 0);
});
