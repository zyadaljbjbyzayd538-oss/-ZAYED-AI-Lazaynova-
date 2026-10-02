import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresAiUsageLedger } from '../src/infrastructure/postgres-ai-usage-ledger.js';
import { loadModelPricingSchedule } from '../src/infrastructure/provider-usage-accounting.js';

const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const taskId = '7dd4d15a-11db-4f27-810f-95525e640d2d';
const pricing = loadModelPricingSchedule(JSON.stringify({
  'openai-compatible/private-model-v1': { inputMicrousdPerMillionTokens: 150_000, outputMicrousdPerMillionTokens: 600_000 },
}));

test('Postgres usage ledger stores only model identifiers, token counts, exact estimated cost, and request idempotency', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; },
  } as unknown as Pool;
  const ledger = new PostgresAiUsageLedger(pool, pricing);
  await ledger.recordProviderUsage({
    userId,
    resourceType: 'TASK',
    resourceId: taskId,
    provider: 'openai-compatible',
    model: 'private-model-v1',
    requestId: 'provider-request-17',
    usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /ON CONFLICT \(provider, provider_request_id\) DO NOTHING/);
  assert.deepEqual(calls[0]!.values.slice(0, 10), [
    userId, 'TASK', taskId, 'openai-compatible', 'private-model-v1', 'provider-request-17',
    'REPORTED', 2_000_000, 1_000_000, '900000',
  ]);
  assert.equal(calls[0]!.values[10], pricing.version);
  assert.equal(calls[0]!.sql.includes('prompt'), false);
  assert.equal(JSON.stringify(calls[0]!.values).includes('private prompt'), false);
});

test('Postgres usage ledger records successful non-model API requests without inventing token counts', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; },
  } as unknown as Pool;
  const ledger = new PostgresAiUsageLedger(pool, pricing);
  const requestPriceVersion = 'b'.repeat(64);
  await ledger.recordProviderUsage({
    userId,
    resourceType: 'WORKFLOW_RUN',
    resourceId: taskId,
    provider: 'tavily',
    model: 'advanced-search',
    requestId: 'tavily-request-18',
    usageKind: 'API_REQUEST',
    requestCostMicrousd: '250000',
    pricingVersion: requestPriceVersion,
  });
  assert.equal(calls[0]!.values[6], 'REQUEST_ONLY');
  assert.equal(calls[0]!.values[7], null);
  assert.equal(calls[0]!.values[8], null);
  assert.equal(calls[0]!.values[9], '250000');
  assert.equal(calls[0]!.values[10], requestPriceVersion);
});

test('Postgres usage ledger retains unknown pricing and missing usage as visible unpriced rows', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) { calls.push({ sql, values }); return { rows: [], rowCount: 1 }; },
  } as unknown as Pool;
  const ledger = new PostgresAiUsageLedger(pool, loadModelPricingSchedule(undefined));
  await ledger.recordProviderUsage({ userId, resourceType: 'CHAT', provider: 'unknown-provider', model: 'unknown-model' });
  assert.equal(calls[0]!.values[6], 'UNREPORTED');
  assert.equal(calls[0]!.values[7], null);
  assert.equal(calls[0]!.values[8], null);
  assert.equal(calls[0]!.values[9], null);
});

test('Postgres usage ledger rejects invalid identity and unsafe token counts before SQL', async () => {
  let calls = 0;
  const pool = { async query() { calls += 1; return { rows: [], rowCount: 1 }; } } as unknown as Pool;
  const ledger = new PostgresAiUsageLedger(pool, pricing);
  await assert.rejects(() => ledger.recordProviderUsage({
    userId: 'not-a-uuid', resourceType: 'TASK', provider: 'p', model: 'm',
  }), /attribution is invalid/i);
  await assert.rejects(() => ledger.recordProviderUsage({
    userId, resourceType: 'TASK', provider: 'p', model: 'm', usage: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 },
  }), /token usage is invalid/i);
  assert.equal(calls, 0);
});

test('Postgres usage summary is scoped to the requested owner and exposes unpriced totals without exposing prompts', async () => {
  let queryText = '';
  let values: unknown[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queryText = sql;
      values = params;
      return { rows: [{
        request_count: '3', reported_usage_count: '2', unreported_usage_count: '1', non_token_request_count: '0',
        priced_request_count: '1', unpriced_request_count: '2', input_tokens: '300', output_tokens: '90',
        cost_microusd: '42', pricing_versions: [pricing.version],
      }], rowCount: 1 };
    },
  } as unknown as Pool;
  const ledger = new PostgresAiUsageLedger(pool, pricing);
  const summary = await ledger.getUserUsageSummary(userId);
  assert.deepEqual(values, [userId]);
  assert.match(queryText, /WHERE user_id = \$1/);
  assert.equal(summary.currency, 'USD');
  assert.equal(summary.requestCount, '3');
  assert.equal(summary.unreportedUsageCount, '1');
  assert.equal(summary.unpricedRequestCount, '2');
  assert.equal(summary.costMicrousd, '42');
  assert.deepEqual(summary.pricingVersions, [pricing.version]);
  await assert.rejects(() => ledger.getUserUsageSummary('not-a-uuid'), /owner id is invalid/i);
});
