import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiGateway, AiGatewayRequest } from '../src/domain/ai-gateway.js';
import { HttpError } from '../src/domain/errors.js';
import type { AiUsageRecorder, ProviderUsageReport } from '../src/application/ai-usage-ports.js';
import { estimateProviderCostMicrousd, loadModelPricingSchedule, loadTavilySearchPrice, UsageReportingAiGateway } from '../src/infrastructure/provider-usage-accounting.js';

const usageContext = { userId: '9e82df6f-f302-4a5b-a68a-54641af6945a', resourceType: 'TASK' as const, resourceId: '7dd4d15a-11db-4f27-810f-95525e640d2d' };

function response() {
  return {
    text: 'actual provider response',
    provider: 'openai-compatible',
    model: 'private-model-v1',
    requestId: 'provider-request-1',
    usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    evidence: [],
  };
}

test('pricing schedule is normalized, versioned, and rejects fabricated/ambiguous rates', () => {
  const first = loadModelPricingSchedule(JSON.stringify({
    'OpenAI-Compatible/Private-Model-V1': { inputMicrousdPerMillionTokens: 150_000, outputMicrousdPerMillionTokens: 600_000 },
  }));
  const same = loadModelPricingSchedule(JSON.stringify({
    'openai-compatible/Private-Model-V1': { inputMicrousdPerMillionTokens: 150_000, outputMicrousdPerMillionTokens: 600_000 },
  }));
  assert.equal(first.version, same.version);
  assert.deepEqual(first.get('openai-compatible', 'Private-Model-V1'), {
    inputMicrousdPerMillionTokens: 150_000,
    outputMicrousdPerMillionTokens: 600_000,
  });
  assert.equal(first.get('openai-compatible', 'private-model-v1'), undefined);
  assert.equal(first.get('unknown', 'Private-Model-V1'), undefined);
  assert.notEqual(first.version, loadModelPricingSchedule(JSON.stringify({
    'openai-compatible/private-model-v1': { inputMicrousdPerMillionTokens: 150_000, outputMicrousdPerMillionTokens: 600_000 },
  })).version);
  assert.throws(() => loadModelPricingSchedule('{not-json'), /valid JSON/i);
  assert.throws(() => loadModelPricingSchedule('{"private-model-v1":{"inputMicrousdPerMillionTokens":1,"outputMicrousdPerMillionTokens":1}}'), /invalid provider\/model/i);
  assert.throws(() => loadModelPricingSchedule('{"provider/model":{"inputMicrousdPerMillionTokens":-1,"outputMicrousdPerMillionTokens":1}}'), /invalid rate/i);
  assert.throws(() => loadModelPricingSchedule('{"provider/model":{"inputMicrousdPerMillionTokens":1,"outputMicrousdPerMillionTokens":1,"secret":"x"}}'), /invalid rate/i);
});

test('Tavily request estimates are optional, deterministic, and reject malformed tariff configuration', () => {
  const unknown = loadTavilySearchPrice(undefined);
  const priced = loadTavilySearchPrice('250000');
  assert.equal(unknown.costMicrousd, undefined);
  assert.equal(priced.costMicrousd, '250000');
  assert.equal(priced.version, loadTavilySearchPrice('250000').version);
  assert.notEqual(unknown.version, priced.version);
  assert.throws(() => loadTavilySearchPrice('-1'), /non-negative integer/i);
  assert.throws(() => loadTavilySearchPrice('1.2'), /non-negative integer/i);
});

test('cost estimates use integer micro-USD arithmetic and are not rounded through floating point', () => {
  assert.equal(estimateProviderCostMicrousd(
    { inputTokens: 2_000_000, outputTokens: 1_000_000 },
    { inputMicrousdPerMillionTokens: 150_000, outputMicrousdPerMillionTokens: 600_000 },
  ), '900000');
  assert.equal(estimateProviderCostMicrousd(
    { inputTokens: 1, outputTokens: 1 },
    { inputMicrousdPerMillionTokens: 500_000, outputMicrousdPerMillionTokens: 500_000 },
  ), '1');
  assert.throws(() => estimateProviderCostMicrousd(
    { inputTokens: -1, outputTokens: 0 },
    { inputMicrousdPerMillionTokens: 0, outputMicrousdPerMillionTokens: 0 },
  ), /invalid/i);
});

test('usage-reporting gateway persists trusted per-user attribution before returning a provider completion', async () => {
  const reports: ProviderUsageReport[] = [];
  const recorder: AiUsageRecorder = { async recordProviderUsage(report) { reports.push(report); } };
  const upstream: AiGateway = { async isReady() { return true; }, async generate(_request) { return response(); } };
  const gateway = new UsageReportingAiGateway(upstream, recorder);
  const request: AiGatewayRequest = {
    accountingContext: usageContext,
    systemPrompt: 'internal system text',
    messages: [{ role: 'user', content: 'private prompt must not be stored' }],
  };
  const result = await gateway.generate(request);
  assert.equal(result.text, 'actual provider response');
  assert.deepEqual(reports, [{
    ...usageContext,
    provider: 'openai-compatible',
    model: 'private-model-v1',
    requestId: 'provider-request-1',
    usage: { inputTokens: 2_000_000, outputTokens: 1_000_000 },
  }]);
  assert.equal(JSON.stringify(reports).includes('private prompt'), false);
});

test('usage-reporting gateway records unreported token usage, and records nothing without trusted context', async () => {
  const reports: ProviderUsageReport[] = [];
  const recorder: AiUsageRecorder = { async recordProviderUsage(report) { reports.push(report); } };
  const upstream: AiGateway = {
    async isReady() { return true; },
    async generate() { return { text: 'actual provider response', provider: 'openai-compatible', model: 'private-model-v1', requestId: '', evidence: [] }; },
  };
  const gateway = new UsageReportingAiGateway(upstream, recorder);
  await gateway.generate({ accountingContext: usageContext, systemPrompt: '', messages: [] });
  await gateway.generate({ systemPrompt: '', messages: [] });
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.usage, undefined);
  assert.equal(reports[0]?.requestId, undefined);
});

test('usage-reporting gateway records stream completion but forwards deltas unchanged', async () => {
  const reports: ProviderUsageReport[] = [];
  const recorder: AiUsageRecorder = { async recordProviderUsage(report) { reports.push(report); } };
  const upstream: AiGateway = {
    async isReady() { return true; },
    async generate() { return response(); },
    async *stream() {
      yield { type: 'text_delta', content: 'A real delta.' };
      yield { type: 'completed', provider: 'openai-compatible', model: 'private-model-v1', requestId: 'stream-request-2', usage: { inputTokens: 12, outputTokens: 7 }, evidence: [] };
    },
  };
  const gateway = new UsageReportingAiGateway(upstream, recorder);
  const events = [];
  for await (const event of gateway.stream({ accountingContext: { userId: usageContext.userId, resourceType: 'CHAT' }, systemPrompt: '', messages: [] })) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ['text_delta', 'completed']);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.requestId, 'stream-request-2');
  assert.equal(reports[0]?.resourceType, 'CHAT');
});

test('provider completion is not returned as successful if durable usage recording fails', async () => {
  const recorder: AiUsageRecorder = { async recordProviderUsage() { throw new Error('database detail with no user output'); } };
  const upstream: AiGateway = { async isReady() { return true; }, async generate() { return response(); } };
  const gateway = new UsageReportingAiGateway(upstream, recorder);
  await assert.rejects(
    () => gateway.generate({ accountingContext: usageContext, systemPrompt: '', messages: [] }),
    (error: unknown) => error instanceof HttpError && error.code === 'AI_USAGE_ACCOUNTING_FAILED' && !error.message.includes('database detail'),
  );
});
