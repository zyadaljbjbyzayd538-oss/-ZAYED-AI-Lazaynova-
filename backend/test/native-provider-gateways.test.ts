import test from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicGateway, GeminiGateway } from '../src/infrastructure/native-provider-gateways.js';
import { buildAgentRegistryFromEnvironment, buildAiModelCatalogFromEnvironment, createConfiguredGateway } from '../src/infrastructure/agent-composition.js';
import type { AiGatewayRequest } from '../src/domain/ai-gateway.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const request: AiGatewayRequest = {
  systemPrompt: 'Answer accurately.',
  messages: [{ role: 'user', content: 'What is 6 times 7?' }],
  maxOutputTokens: 128,
};

test('Anthropic adapter queries native Models API and sends API credentials only in headers', async () => {
  const observed: { url: string; headers: Headers } = { url: '', headers: new Headers() };
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-test', apiKey: 'anthropic-secret',
  }, async (input, init) => {
    observed.url = String(input);
    observed.headers = new Headers(init?.headers);
    return jsonResponse({ data: [{ id: 'claude-haiku-test' }, { id: 'claude-sonnet-test' }] });
  });
  assert.deepEqual(await gateway.listModels(), ['claude-haiku-test', 'claude-sonnet-test']);
  assert.equal(observed.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(observed.headers.get('x-api-key'), 'anthropic-secret');
  assert.equal(observed.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(observed.url.includes('anthropic-secret'), false);
  assert.equal(await gateway.isReady(), true);
});

test('Anthropic native inventory confirms a configured model outside the first 100 listed IDs', async () => {
  const observedUrls: string[] = [];
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-hidden-test', apiKey: 'anthropic-secret',
  }, async (input) => {
    const url = String(input);
    observedUrls.push(url);
    if (url.endsWith('/models?limit=100')) {
      return jsonResponse({ data: Array.from({ length: 100 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` })) });
    }
    assert.equal(url, 'https://api.anthropic.com/v1/models/claude-hidden-test');
    return jsonResponse({ id: 'claude-hidden-test', type: 'model' });
  });
  const models = await gateway.listModels();
  assert.equal(models.length, 100);
  assert.equal(models.includes('claude-hidden-test'), true);
  assert.deepEqual(observedUrls, [
    'https://api.anthropic.com/v1/models?limit=100',
    'https://api.anthropic.com/v1/models/claude-hidden-test',
  ]);
});

test('Anthropic adapter calls Messages API, maps system/messages, and records safe usage provenance', async () => {
  const observed: { url: string; headers: Headers; body: Record<string, unknown> } = { url: '', headers: new Headers(), body: {} };
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-test', apiKey: 'anthropic-secret',
  }, async (input, init) => {
    observed.url = String(input);
    observed.headers = new Headers(init?.headers);
    observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      id: 'msg_test_1', type: 'message', model: 'claude-sonnet-test-v2',
      content: [{ type: 'text', text: 'The answer is 42.' }],
      usage: { input_tokens: 11, output_tokens: 7 },
    }, 200, { 'request-id': 'req_anthropic_1' });
  });
  const result = await gateway.generate(request);
  assert.equal(observed.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(observed.headers.get('x-api-key'), 'anthropic-secret');
  assert.equal(observed.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(observed.body.model, 'claude-sonnet-test');
  assert.equal(observed.body.max_tokens, 128);
  assert.deepEqual(observed.body.system, 'Answer accurately.');
  assert.deepEqual(observed.body.messages, [{ role: 'user', content: 'What is 6 times 7?' }]);
  assert.equal(result.text, 'The answer is 42.');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-sonnet-test-v2');
  assert.equal(result.requestId, 'req_anthropic_1');
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });
  const inputSha256 = result.evidence[0]?.inputSha256;
  assert.equal(typeof inputSha256, 'string');
  assert.equal((inputSha256 as string).length, 64);
  assert.equal(JSON.stringify(result).includes('anthropic-secret'), false);
});

test('Anthropic adapter requires and round-trips only the declared client tool call', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-test', apiKey: 'anthropic-secret',
  }, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) return jsonResponse({
      id: 'msg_tool_1', model: 'claude-sonnet-test', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_search_1', name: 'web_search', input: { query: 'official model docs' } }],
      usage: { input_tokens: 30, output_tokens: 8 },
    });
    return jsonResponse({ id: 'msg_final_1', model: 'claude-sonnet-test', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the verified summary.' }] });
  });
  const tool = { name: 'web_search', description: 'Search approved sources.', parameters: {
    type: 'object', properties: { query: { type: 'string', maxLength: 4000 } }, required: ['query'], additionalProperties: false,
  } };
  const first = await gateway.generate({
    systemPrompt: 'Call search.', messages: [{ role: 'user', content: 'Find official docs.' }], tools: [tool], toolChoice: 'required',
  });
  assert.deepEqual(first.toolCalls, [{ id: 'toolu_search_1', name: 'web_search', input: { query: 'official model docs' } }]);
  assert.deepEqual(requests[0]?.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.deepEqual(requests[0]?.tools, [{ name: 'web_search', description: 'Search approved sources.', input_schema: tool.parameters }]);
  const final = await gateway.generate({
    systemPrompt: 'Summarize sources.',
    messages: [
      { role: 'user', content: 'Find official docs.' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerContext: first.providerContext },
      { role: 'tool', name: 'web_search', toolCallId: 'toolu_search_1', content: '{"sources":[{"title":"Docs"}]}' },
    ],
  });
  const messages = requests[1]?.messages as Array<Record<string, unknown>>;
  assert.deepEqual(messages[1], { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_search_1', name: 'web_search', input: { query: 'official model docs' } }] });
  assert.deepEqual(messages[2], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_search_1', content: '{"sources":[{"title":"Docs"}]}' }] });
  assert.equal(final.text, 'Here is the verified summary.');
  assert.equal(final.toolCalls, undefined);
  assert.equal(JSON.stringify(requests).includes('anthropic-secret'), false);
});

test('Anthropic failures never expose upstream secrets or response details', async () => {
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-test', apiKey: 'secret-anthropic-key',
  }, async () => new Response('secret-anthropic-key and internal response details', { status: 401 }));
  await assert.rejects(() => gateway.generate(request), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'AI_GATEWAY_REQUEST_FAILED');
    assert.equal((error as Error).message.includes('secret-anthropic-key'), false);
    assert.equal((error as Error).message.includes('internal response'), false);
    return true;
  });
  await assert.rejects(() => gateway.listModels(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'AI_MODEL_CATALOG_UNAVAILABLE');
    return true;
  });
});

test('Gemini adapter lists only generateContent models and keeps the key out of the URL', async () => {
  const observed: { url: string; headers: Headers } = { url: '', headers: new Headers() };
  const gateway = new GeminiGateway({
    protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-test', apiKey: 'gemini-secret',
  }, async (input, init) => {
    observed.url = String(input);
    observed.headers = new Headers(init?.headers);
    return jsonResponse({ models: [
      { name: 'models/gemini-flash-test', baseModelId: 'gemini-flash-test', supportedActions: ['generateContent'] },
      { name: 'models/gemini-embed-test', baseModelId: 'gemini-embed-test', supportedActions: ['embedContent'] },
      { name: 'models/gemini-legacy-test', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-unknown-capability-test', baseModelId: 'gemini-unknown-capability-test' },
    ] });
  });
  assert.deepEqual(await gateway.listModels(), ['gemini-flash-test', 'gemini-legacy-test']);
  assert.equal(observed.url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100');
  assert.equal(observed.headers.get('x-goog-api-key'), 'gemini-secret');
  assert.equal(observed.url.includes('gemini-secret'), false);
  assert.equal(await gateway.isReady(), true);
});

test('Gemini adapter maps native generateContent requests and captures response usage', async () => {
  const observed: { url: string; headers: Headers; body: Record<string, unknown> } = { url: '', headers: new Headers(), body: {} };
  const gateway = new GeminiGateway({
    protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-test', apiKey: 'gemini-secret',
  }, async (input, init) => {
    observed.url = String(input);
    observed.headers = new Headers(init?.headers);
    observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      responseId: 'gemini-request-1', modelVersion: 'gemini-flash-test-002',
      candidates: [{ content: { parts: [{ text: '42' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
    });
  });
  const result = await gateway.generate({ ...request, messages: [
    { role: 'assistant', content: 'Use arithmetic.' },
    { role: 'user', content: 'What is 6 times 7?' },
  ] });
  assert.equal(observed.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-test:generateContent');
  assert.equal(observed.headers.get('x-goog-api-key'), 'gemini-secret');
  assert.deepEqual(observed.body.systemInstruction, { parts: [{ text: 'Answer accurately.' }] });
  assert.deepEqual(observed.body.contents, [
    { role: 'model', parts: [{ text: 'Use arithmetic.' }] },
    { role: 'user', parts: [{ text: 'What is 6 times 7?' }] },
  ]);
  assert.deepEqual(observed.body.generationConfig, { maxOutputTokens: 128 });
  assert.equal(result.text, '42');
  assert.equal(result.provider, 'google-gemini');
  assert.equal(result.model, 'gemini-flash-test-002');
  assert.equal(result.requestId, 'gemini-request-1');
  assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 2 });
  assert.equal(JSON.stringify(result).includes('gemini-secret'), false);
});

test('Gemini adapter round-trips the declared function call and preserves its thought signature', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const gateway = new GeminiGateway({
    protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-test', apiKey: 'gemini-secret',
  }, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) return jsonResponse({
      modelVersion: 'gemini-flash-test',
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'gem-call-1', name: 'web_search', args: { query: 'official docs' } }, thoughtSignature: 'opaque-signature' }] } }],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 5 },
    });
    return jsonResponse({ modelVersion: 'gemini-flash-test', candidates: [{ content: { role: 'model', parts: [{ text: 'Verified summary.' }] } }] });
  });
  const tool = { name: 'web_search', description: 'Search approved sources.', parameters: {
    type: 'object', properties: { query: { type: 'string', maxLength: 4000 } }, required: ['query'], additionalProperties: false,
  } };
  const first = await gateway.generate({
    systemPrompt: 'Call search.', messages: [{ role: 'user', content: 'Find official docs.' }], tools: [tool], toolChoice: 'required',
  });
  assert.deepEqual(first.toolCalls, [{ id: 'gem-call-1', name: 'web_search', input: { query: 'official docs' } }]);
  assert.deepEqual(requests[0]?.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['web_search'] } });
  assert.deepEqual(requests[0]?.tools, [{ functionDeclarations: [{ name: 'web_search', description: 'Search approved sources.', parameters: tool.parameters }] }]);
  const final = await gateway.generate({
    systemPrompt: 'Summarize sources.',
    messages: [
      { role: 'user', content: 'Find official docs.' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls, providerContext: first.providerContext },
      { role: 'tool', name: 'web_search', toolCallId: 'gem-call-1', content: '{"sources":[{"title":"Docs"}]}' },
    ],
  });
  const contents = requests[1]?.contents as Array<Record<string, unknown>>;
  assert.deepEqual(contents[1], {
    role: 'model', parts: [{ functionCall: { id: 'gem-call-1', name: 'web_search', args: { query: 'official docs' } }, thoughtSignature: 'opaque-signature' }],
  });
  assert.deepEqual(contents[2], {
    role: 'user', parts: [{ functionResponse: { name: 'web_search', response: { sources: [{ title: 'Docs' }] }, id: 'gem-call-1' } }],
  });
  assert.equal(final.text, 'Verified summary.');
  assert.equal(final.toolCalls, undefined);
  assert.equal(JSON.stringify(requests).includes('gemini-secret'), false);
});

test('Anthropic Messages streaming emits text deltas and accurate completion usage', async () => {
  let observed: { url: string; headers: Headers; body: Record<string, unknown> } = { url: '', headers: new Headers(), body: {} };
  const gateway = new AnthropicGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-stream', apiKey: 'anthropic-stream-secret',
  }, async (input, init) => {
    observed = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg-stream-1","model":"claude-stream-v2","usage":{"input_tokens":8}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"there."}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream', 'request-id': 'anthropic-stream-request' } });
  });
  const events = [];
  for await (const event of gateway.stream!(request)) events.push(event);
  assert.equal(observed.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(observed.headers.get('x-api-key'), 'anthropic-stream-secret');
  assert.equal(observed.headers.get('accept'), 'text/event-stream');
  assert.equal(observed.body.stream, true);
  assert.deepEqual(events.map((event) => event.type === 'text_delta' ? event.content : 'COMPLETED'), ['Hello ', 'there.', 'COMPLETED']);
  const completed = events[2];
  assert.equal(completed?.type, 'completed');
  if (completed?.type === 'completed') {
    assert.equal(completed.model, 'claude-stream-v2');
    assert.equal(completed.requestId, 'anthropic-stream-request');
    assert.deepEqual(completed.usage, { inputTokens: 8, outputTokens: 3 });
  }
  assert.equal(JSON.stringify(observed).includes('anthropic-stream-secret'), false);
});

test('Gemini streamGenerateContent maps server-side credentials and emits text deltas', async () => {
  let observed: { url: string; headers: Headers; body: Record<string, unknown> } = { url: '', headers: new Headers(), body: {} };
  const gateway = new GeminiGateway({
    protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-stream', apiKey: 'gemini-stream-secret',
  }, async (input, init) => {
    observed = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return new Response([
      'data: {"responseId":"gemini-stream-1","modelVersion":"gemini-stream-v2","candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}',
      '',
      'data: {"responseId":"gemini-stream-1","modelVersion":"gemini-stream-v2","candidates":[{"content":{"parts":[{"text":"there."}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":3}}',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream', 'x-goog-request-id': 'gemini-stream-request' } });
  });
  const events = [];
  for await (const event of gateway.stream!(request)) events.push(event);
  assert.equal(observed.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-stream:streamGenerateContent?alt=sse');
  assert.equal(observed.headers.get('x-goog-api-key'), 'gemini-stream-secret');
  assert.equal(observed.body.generationConfig && (observed.body.generationConfig as Record<string, unknown>).maxOutputTokens, 128);
  assert.deepEqual(events.map((event) => event.type === 'text_delta' ? event.content : 'COMPLETED'), ['Hello ', 'there.', 'COMPLETED']);
  const completed = events[2];
  assert.equal(completed?.type, 'completed');
  if (completed?.type === 'completed') {
    assert.equal(completed.model, 'gemini-stream-v2');
    assert.equal(completed.requestId, 'gemini-stream-request');
    assert.deepEqual(completed.usage, { inputTokens: 8, outputTokens: 3 });
  }
  assert.equal(JSON.stringify(observed).includes('gemini-stream-secret'), false);
});

test('provider composition enables native adapters through explicit server-side profiles and routes', async () => {
  const env = {
    AI_GATEWAY_PROVIDERS: 'claude,gemini',
    AI_GATEWAY_CLAUDE_PROTOCOL: 'anthropic',
    AI_GATEWAY_CLAUDE_MODEL: 'claude-sonnet-test',
    AI_GATEWAY_CLAUDE_API_KEY: 'server-secret-claude',
    AI_GATEWAY_GEMINI_PROTOCOL: 'gemini',
    AI_GATEWAY_GEMINI_MODEL: 'gemini-flash-test',
    AI_GATEWAY_GEMINI_API_KEY: 'server-secret-gemini',
    AI_CHAT_PROVIDER: 'claude',
    AI_MODEL_ANALYSIS_PROVIDER: 'gemini',
  };
  assert.ok(createConfiguredGateway({
    protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-test', apiKey: 'test-secret',
  }) instanceof AnthropicGateway);
  assert.ok(createConfiguredGateway({
    protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-flash-test', apiKey: 'test-secret',
  }) instanceof GeminiGateway);
  const routedProtocols: string[] = [];
  const registry = buildAgentRegistryFromEnvironment(env, (config) => {
    routedProtocols.push(`${config.protocol}:${config.model}`);
    return {
      async isReady() { return true; },
      async generate() { return { text: config.model, provider: config.protocol, model: config.model, requestId: 'test-request', evidence: [{ kind: 'model_execution' }] }; },
    };
  });
  assert.equal((await registry.readiness('CHAT')).ready, true);
  assert.equal((await registry.readiness('MODEL_ANALYSIS')).ready, true);
  const chat = await registry.execute({ taskId: null, userId: 'user-1', capability: 'CHAT', input: { text: 'hello', attachments: [] } });
  const analysis = await registry.execute({ taskId: 'task-1', userId: 'user-1', capability: 'MODEL_ANALYSIS', input: { text: 'analyze', attachments: [] } });
  assert.deepEqual(chat.result, { text: 'claude-sonnet-test' });
  assert.deepEqual(analysis.result, { text: 'gemini-flash-test' });
  assert.deepEqual(routedProtocols.sort(), ['anthropic:claude-sonnet-test', 'gemini:gemini-flash-test']);
  const nativeDefaults: string[] = [];
  const catalog = buildAiModelCatalogFromEnvironment(env, (config) => {
    nativeDefaults.push(`${config.protocol}:${config.baseUrl}`);
    return { async listModels() { return [config.model]; } };
  });
  assert.deepEqual(nativeDefaults.sort(), [
    'anthropic:https://api.anthropic.com/v1',
    'gemini:https://generativelanguage.googleapis.com/v1beta',
  ]);
  const providers = await catalog.listProviderInventories();
  assert.deepEqual(providers.map((provider) => [provider.profileName, provider.assignedCapabilities, provider.availability]), [
    ['claude', ['CHAT'], 'AVAILABLE'],
    ['gemini', ['MODEL_ANALYSIS'], 'AVAILABLE'],
  ]);
  assert.equal(JSON.stringify(providers).includes('server-secret'), false);
  assert.throws(() => buildAiModelCatalogFromEnvironment({
    AI_GATEWAY_PROVIDERS: 'claude',
    AI_GATEWAY_CLAUDE_PROTOCOL: 'anthropic',
    AI_GATEWAY_CLAUDE_MODEL: 'claude-sonnet-test',
  }), /API_KEY is required/);
});
