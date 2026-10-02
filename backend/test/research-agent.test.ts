import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/domain/errors.js';
import { WebResearchAgentDriver } from '../src/application/ai-drivers.js';
import type { AiGateway, AiGatewayRequest } from '../src/domain/ai-gateway.js';
import type { ResearchProvider, ResearchSearchResult } from '../src/application/research-ports.js';
import type { AgentExecutionContext } from '../src/domain/types.js';
import { verifyResult } from '../src/domain/verifier.js';
import { TavilyResearchProvider } from '../src/infrastructure/tavily-research-provider.js';

const captured: ResearchSearchResult = {
  provider: 'tavily', requestId: 'search-request-1', fetchedAt: '2026-09-29T12:00:00.000Z', rawSourceSha256: 'c'.repeat(64),
  sources: [{
    title: 'Public research source', url: 'https://example.org/research', excerpt: 'Retrieved excerpt from the page.',
    content: 'Retrieved page content with traceable claims.',
  }],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'tavily-request-id' } });
}

test('Tavily adapter uses a fixed HTTPS endpoint and returns bounded, deduplicated HTTPS source captures', async () => {
  const submitted: { body?: Record<string, unknown> } = {};
  let calledUrl = '';
  const provider = new TavilyResearchProvider('server-secret', 10_000, async (input, init) => {
    calledUrl = String(input);
    submitted.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      results: [
        { title: 'Source', url: 'https://example.org/article#fragment', content: 'snippet', raw_content: 'Retrieved full text.' },
        { title: 'Duplicate', url: 'https://example.org/article', content: 'snippet', raw_content: 'duplicate full text' },
        { title: 'Insecure', url: 'http://example.org/article', content: 'snippet', raw_content: 'ignored' },
        { title: 'No capture', url: 'https://example.org/summary', content: 'snippet', raw_content: '' },
      ],
    });
  });
  const result = await provider.search(`  ${'topic '.repeat(100)}  `);
  assert.equal(calledUrl, 'https://api.tavily.com/search');
  assert.equal(submitted.body?.api_key, 'server-secret');
  assert.equal(String(submitted.body?.query).length, 400);
  assert.equal(submitted.body?.include_raw_content, true);
  assert.equal(result.provider, 'tavily');
  assert.equal(result.requestId, 'tavily-request-id');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.url, 'https://example.org/article');
  assert.match(result.rawSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('server-secret'), false);
});

test('Tavily fails closed on a redirect toward a private address and never requests returned source URLs', async () => {
  const requestedUrls: string[] = [];
  let redirectMode: RequestRedirect | undefined;
  const provider = new TavilyResearchProvider('server-secret', 10_000, async (input, init) => {
    requestedUrls.push(String(input));
    redirectMode = init?.redirect;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
  });
  await assert.rejects(() => provider.search('Research this URL: http://127.0.0.1/admin'), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'RESEARCH_PROVIDER_REQUEST_FAILED');
    return true;
  });
  assert.equal(redirectMode, 'error');
  assert.deepEqual(requestedUrls, ['https://api.tavily.com/search']);
});

test('Tavily accounts for an accepted billable request before source parsing can fail', async () => {
  const receipts: Array<{ provider: string; requestId: string }> = [];
  const provider = new TavilyResearchProvider('server-secret', 10_000, async () => jsonResponse({ results: [] }));
  await assert.rejects(() => provider.search('topic', undefined, async (receipt) => { receipts.push(receipt); }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'RESEARCH_NO_VERIFIABLE_SOURCES');
    return true;
  });
  assert.deepEqual(receipts, [{ provider: 'tavily', requestId: 'tavily-request-id' }]);
});

test('Tavily fails closed if durable accounting cannot record an accepted request', async () => {
  const provider = new TavilyResearchProvider('server-secret', 10_000, async () => jsonResponse({ results: [] }));
  await assert.rejects(() => provider.search('topic', undefined, async () => { throw new Error('database detail'); }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'AI_USAGE_ACCOUNTING_FAILED');
    assert.equal(error.message.includes('database detail'), false);
    return true;
  });
});

test('Web Research agent returns real citations, capture hash, and model synthesis for verifier', async () => {
  let modelRequest: AiGatewayRequest | undefined;
  const gateway: AiGateway = {
    async isReady() { return true; },
    async generate(request) {
      modelRequest = request;
      return {
        text: 'The retrieved source supports this summary [1].', provider: 'local-model-gateway', model: 'research-model',
        requestId: 'model-request-1', evidence: [{ kind: 'model_execution', provider: 'local-model-gateway', model: 'research-model' }],
      };
    },
  };
  const research: ResearchProvider = {
    async isReady() { return true; },
    async search(query) { assert.equal(query, 'Research the topic'); return captured; },
  };
  const context: AgentExecutionContext = {
    taskId: 'task-1', userId: 'owner-1', capability: 'WEB_RESEARCH',
    input: { text: 'Research the topic', attachments: [] },
  };
  const result = await new WebResearchAgentDriver(gateway, research).execute(context);
  assert.equal(verifyResult('WEB_RESEARCH', result).passed, true);
  assert.deepEqual(result.result, {
    text: 'The retrieved source supports this summary [1].',
    sources: [{ number: 1, title: 'Public research source', url: 'https://example.org/research', excerpt: 'Retrieved excerpt from the page.' }],
  });
  assert.ok(modelRequest);
  assert.match(modelRequest.systemPrompt, /untrusted data/);
  assert.match(modelRequest.messages[0]?.content ?? '', /Retrieved page content with traceable claims/);
});

test('Web Research directs attachments to the File Analysis capability', async () => {
  const research: ResearchProvider = { async isReady() { return true; }, async search() { throw new Error('must not run'); } };
  const gateway: AiGateway = { async isReady() { return true; }, async generate() { throw new Error('must not run'); } };
  const context: AgentExecutionContext = {
    taskId: 'task-2', userId: 'owner-1', capability: 'WEB_RESEARCH',
    input: { text: 'Research this', attachments: ['file-1'] },
  };
  await assert.rejects(() => new WebResearchAgentDriver(gateway, research).execute(context), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS');
    return true;
  });
});
