import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleGateway } from '../src/infrastructure/openai-compatible-gateway.js';
import { buildAgentRegistryFromEnvironment, buildTaskPlannerFromEnvironment } from '../src/infrastructure/agent-composition.js';
import { CapabilityPlanner } from '../src/application/capability-planner.js';
import { ModelTaskPlanner } from '../src/application/model-task-planner.js';
import { HttpError } from '../src/domain/errors.js';
import { ChatAgentDriver, FileAnalysisAgentDriver, ModelAnalysisAgentDriver, WritingAgentDriver } from '../src/application/ai-drivers.js';
import type { FileService } from '../src/application/file-ports.js';
import type { AiGateway, AiGatewayRequest } from '../src/domain/ai-gateway.js';
import type { AgentExecutionContext } from '../src/domain/types.js';
import { verifyResult } from '../src/domain/verifier.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('private HTTP inference endpoints require an explicit non-production opt-in', () => {
  assert.throws(() => new OpenAiCompatibleGateway({ baseUrl: 'http://ollama:11434/v1', model: 'local-model' }), /explicit private-network opt-in/);
  assert.doesNotThrow(() => new OpenAiCompatibleGateway({
    baseUrl: 'http://ollama:11434/v1', model: 'local-model', allowInsecureHttp: true,
  }));
});

test('gateway readiness requires the configured model to be available upstream', async () => {
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model', readinessCacheMs: 0 }, async () =>
    jsonResponse({ data: [{ id: 'another-model' }] }));
  assert.equal(await gateway.isReady(), false);
});

test('gateway model inventory is queried live, bounded, sanitized, and never exposes provider credentials', async () => {
  let authorization: string | null = null;
  const gateway = new OpenAiCompatibleGateway({
    baseUrl: 'https://secret-host.example.test/v1', model: 'selected-model', apiKey: 'server-only-key',
  }, async (input, init) => {
    assert.equal(String(input), 'https://secret-host.example.test/v1/models');
    authorization = new Headers(init?.headers).get('authorization');
    return jsonResponse({ data: [
      { id: 'z-model' }, { id: 'selected-model' }, { id: 'selected-model' },
      { id: 'bad\u0000model' }, { id: 'x'.repeat(201) }, { owner: 'missing-id' },
    ] });
  });
  assert.deepEqual(await gateway.listModels(), ['selected-model', 'z-model']);
  assert.equal(authorization, 'Bearer server-only-key');
});

test('gateway model inventory keeps the configured model visible when more than 100 models exist', async () => {
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'z-selected-model' }, async () =>
    jsonResponse({ data: [...Array.from({ length: 110 }, (_, index) => ({ id: `model-${String(index).padStart(3, '0')}` })), { id: 'z-selected-model' }] }));
  const models = await gateway.listModels();
  assert.equal(models.length, 100);
  assert.equal(models.includes('z-selected-model'), true);
});

test('gateway model inventory failure is reduced to a safe stable error', async () => {
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'selected-model', apiKey: 'do-not-leak' }, async () =>
    new Response('private upstream body containing do-not-leak', { status: 502 }));
  await assert.rejects(() => gateway.listModels(), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'AI_MODEL_CATALOG_UNAVAILABLE');
    assert.equal(error.message.includes('do-not-leak'), false);
    return true;
  });
});

test('gateway model inventory rejects oversized provider responses', async () => {
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'selected-model' }, async () =>
    new Response(' '.repeat(1_048_577), { headers: { 'content-type': 'application/json' } }));
  await assert.rejects(() => gateway.listModels(), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'AI_MODEL_CATALOG_UNAVAILABLE');
    return true;
  });
});

test('gateway sends real completion requests and returns hashed provenance without exposing credentials', async () => {
  let requestBody: Record<string, unknown> | null = null;
  let requestAuthorization: string | null = null;
  const gateway = new OpenAiCompatibleGateway({
    baseUrl: 'https://ai.example.test/v1', model: 'private-model', apiKey: 'test-server-secret', readinessCacheMs: 0,
  }, async (input, init) => {
    const url = String(input);
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'private-model' }] });
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestAuthorization = new Headers(init?.headers).get('authorization');
    return jsonResponse({
      id: 'provider-request-1', model: 'private-model-v2',
      choices: [{ message: { content: 'A real gateway response.' } }],
      usage: { prompt_tokens: 8, completion_tokens: 5 },
    }, 200, { 'x-request-id': 'provider-request-1' });
  });
  assert.equal(await gateway.isReady(), true);
  const result = await gateway.generate({ systemPrompt: 'Be accurate.', messages: [{ role: 'user', content: 'Write a note.' }] });
  assert.equal(result.text, 'A real gateway response.');
  assert.equal(result.model, 'private-model-v2');
  assert.equal(result.requestId, 'provider-request-1');
  assert.equal(result.evidence[0]?.kind, 'model_execution');
  assert.equal(requestAuthorization, 'Bearer test-server-secret');
  assert.equal(JSON.stringify(requestBody).includes('test-server-secret'), false);
});

test('OpenAI-compatible adapter streams real provider deltas and a completion event', async () => {
  const observed: { body?: Record<string, unknown>; accept?: string | null } = {};
  const gateway = new OpenAiCompatibleGateway({
    baseUrl: 'https://ai.example.test/v1', model: 'private-model', apiKey: 'stream-server-secret',
  }, async (input, init) => {
    assert.equal(String(input), 'https://ai.example.test/v1/chat/completions');
    observed.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    observed.accept = new Headers(init?.headers).get('accept');
    return new Response([
      'data: {"id":"stream-1","model":"private-model-v2","choices":[{"delta":{"content":"Hello "}}]}',
      '',
      'data: {"id":"stream-1","model":"private-model-v2","choices":[{"delta":{"content":"world."}}]}',
      '',
      'data: {"id":"stream-1","model":"private-model-v2","choices":[],"usage":{"prompt_tokens":6,"completion_tokens":2}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'stream-1' } });
  });

  const events = [];
  for await (const event of gateway.stream!({ systemPrompt: 'Answer briefly.', messages: [{ role: 'user', content: 'Say hello.' }] })) events.push(event);
  assert.equal(observed.accept, 'text/event-stream');
  assert.equal(observed.body?.stream, true);
  assert.deepEqual(events.map((event) => event.type === 'text_delta' ? event.content : 'COMPLETED'), ['Hello ', 'world.', 'COMPLETED']);
  const completed = events[2];
  assert.equal(completed?.type, 'completed');
  if (completed?.type === 'completed') {
    assert.equal(completed.provider, 'ai.example.test');
    assert.equal(completed.model, 'private-model-v2');
    assert.deepEqual(completed.usage, { inputTokens: 6, outputTokens: 2 });
    assert.equal(completed.evidence[0]?.kind, 'model_execution');
  }
});

test('OpenAI-compatible gateway cancels upstream when its caller stops consuming deltas', async () => {
  let upstreamCancelled = false;
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model' }, async () =>
    new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      },
      cancel() { upstreamCancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }));
  const stream = gateway.stream!({ systemPrompt: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }] });
  assert.deepEqual(await stream.next(), { value: { type: 'text_delta', content: 'first' }, done: false });
  await stream.return(undefined);
  assert.equal(upstreamCancelled, true);
});

test('OpenAI-compatible adapter fails closed on truncated or oversized event streams', async () => {
  const truncatedGateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model' }, async () =>
    new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }));
  const partial: string[] = [];
  await assert.rejects(async () => {
    for await (const event of truncatedGateway.stream!({ systemPrompt: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }] })) {
      if (event.type === 'text_delta') partial.push(event.content);
    }
  }, (error: unknown) => error instanceof HttpError && error.code === 'AI_GATEWAY_REQUEST_FAILED');
  assert.deepEqual(partial, ['partial']);

  const oversizedGateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model' }, async () =>
    new Response('', {
      headers: { 'content-type': 'text/event-stream', 'content-length': String(4_194_305) },
    }));
  await assert.rejects(async () => {
    for await (const _event of oversizedGateway.stream!({ systemPrompt: 'Be concise.', messages: [{ role: 'user', content: 'Hello' }] })) { /* consume */ }
  }, (error: unknown) => error instanceof HttpError && error.code === 'AI_GATEWAY_REQUEST_FAILED');
});

test('OpenAI-compatible adapter round-trips a required function call without invoking it itself', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model', apiKey: 'openai-server-secret' }, async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body, headers: new Headers(init?.headers) });
    if (requests.length === 1) return jsonResponse({
      model: 'private-model', choices: [{ message: { content: null, tool_calls: [{
        id: 'call_web_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"official weather forecast"}' },
      }] } }], usage: { prompt_tokens: 20, completion_tokens: 7 },
    });
    return jsonResponse({ model: 'private-model', choices: [{ message: { content: 'Retrieved sources say it is sunny.' } }] });
  });
  const tool = { name: 'web_search', description: 'Search bounded web sources.', parameters: {
    type: 'object', properties: { query: { type: 'string', maxLength: 4000 } }, required: ['query'], additionalProperties: false,
  } };
  const first = await gateway.generate({ systemPrompt: 'Call the tool.', messages: [{ role: 'user', content: 'Weather today?' }], tools: [tool], toolChoice: 'required' });
  assert.equal(first.text, '');
  assert.deepEqual(first.toolCalls, [{ id: 'call_web_1', name: 'web_search', input: { query: 'official weather forecast' } }]);
  assert.equal(requests[0]?.body.tool_choice, 'required');
  assert.deepEqual(requests[0]?.body.tools, [{ type: 'function', function: { ...tool, strict: true } }]);
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer openai-server-secret');
  const final = await gateway.generate({
    systemPrompt: 'Summarize the tool output.',
    messages: [
      { role: 'user', content: 'Weather today?' },
      { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
      { role: 'tool', name: 'web_search', toolCallId: 'call_web_1', content: '{"sources":[{"title":"Weather","url":"https://weather.example/"}]}' },
    ],
  });
  const messages = requests[1]?.body.messages as Array<Record<string, unknown>>;
  assert.equal(messages[2]?.role, 'assistant');
  assert.equal((messages[2]?.tool_calls as Array<Record<string, unknown>>)[0]?.type, 'function');
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: 'call_web_1', content: '{"sources":[{"title":"Weather","url":"https://weather.example/"}]}' });
  assert.equal(final.text, 'Retrieved sources say it is sunny.');
  assert.equal(final.toolCalls, undefined);
  assert.equal(JSON.stringify(first).includes('openai-server-secret'), false);
});

test('gateway fails safely on malformed provider output', async () => {
  const gateway = new OpenAiCompatibleGateway({ baseUrl: 'https://ai.example.test/v1', model: 'private-model' }, async () =>
    jsonResponse({ choices: [{ message: { content: '' } }] }));
  await assert.rejects(() => gateway.generate({ systemPrompt: 'Be accurate.', messages: [{ role: 'user', content: 'Hello.' }] }), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'AI_GATEWAY_REQUEST_FAILED');
    return true;
  });
});

test('unconfigured gateway stays unavailable; legacy configuration registers real adapters', async () => {
  const empty = buildAgentRegistryFromEnvironment({});
  assert.equal((await empty.readiness('CHAT')).ready, false);
  const legacy = buildAgentRegistryFromEnvironment({ AI_GATEWAY_BASE_URL: 'https://ai.example.test/v1', AI_GATEWAY_MODEL: 'model' }, () => ({
    async isReady() { return true; },
    async generate(request: AiGatewayRequest) {
      return { text: 'generated', provider: 'private', model: 'model', requestId: 'r', evidence: [{ kind: 'model_execution' }] };
    },
  }));
  assert.equal((await legacy.readiness('CHAT')).ready, true);
  assert.equal((await legacy.readiness('WRITING')).ready, true);
});

test('private and commercial gateway profiles can be selected per capability without implicit fallback', async () => {
  const env = {
    AI_GATEWAY_PROVIDERS: 'local,cloud',
    AI_GATEWAY_LOCAL_BASE_URL: 'http://ollama:11434/v1', AI_GATEWAY_LOCAL_MODEL: 'local-model', AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP: 'true',
    AI_GATEWAY_CLOUD_BASE_URL: 'https://ai.example.test/v1', AI_GATEWAY_CLOUD_MODEL: 'cloud-model', AI_GATEWAY_CLOUD_API_KEY: 'cloud-secret',
    AI_CHAT_PROVIDER: 'local', AI_WRITING_PROVIDER: 'local', AI_MODEL_ANALYSIS_PROVIDER: 'cloud',
  };
  const usedModels: string[] = [];
  const registry = buildAgentRegistryFromEnvironment(env, (config) => {
    usedModels.push(config.model);
    return { async isReady() { return true; }, async generate() {
      return { text: config.model, provider: config.model, model: config.model, requestId: 'r', evidence: [{ kind: 'model_execution' }] };
    } };
  });
  assert.equal((await registry.readiness('CHAT')).ready, true);
  assert.equal((await registry.readiness('WRITING')).ready, true);
  assert.equal((await registry.readiness('MODEL_ANALYSIS')).ready, true);
  assert.deepEqual(usedModels.sort(), ['cloud-model', 'local-model']);
  const chat = await registry.execute({ taskId: null, userId: 'u', capability: 'CHAT', input: { text: 'hello', attachments: [] } });
  const analysis = await registry.execute({ taskId: null, userId: 'u', capability: 'MODEL_ANALYSIS', input: { text: 'analyze', attachments: [] } });
  assert.deepEqual(chat.result, { text: 'local-model' });
  assert.deepEqual(analysis.result, { text: 'cloud-model' });
  assert.equal(JSON.stringify(analysis).includes('cloud-secret'), false);
});

test('multiple configured AI profiles require an explicit capability route', () => {
  const env = {
    AI_GATEWAY_PROVIDERS: 'local,cloud',
    AI_GATEWAY_LOCAL_BASE_URL: 'https://local.example.test/v1', AI_GATEWAY_LOCAL_MODEL: 'local',
    AI_GATEWAY_CLOUD_BASE_URL: 'https://cloud.example.test/v1', AI_GATEWAY_CLOUD_MODEL: 'cloud',
  };
  const registry = buildAgentRegistryFromEnvironment(env);
  assert.equal((registry as unknown as { registeredCount(): number }).registeredCount(), 0);
});

test('Web Research registers only when its model profile and search-provider credential are configured', async () => {
  const base = { AI_GATEWAY_BASE_URL: 'https://ai.example.test/v1', AI_GATEWAY_MODEL: 'model' };
  assert.equal((await buildAgentRegistryFromEnvironment(base).readiness('WEB_RESEARCH')).ready, false);
  assert.throws(() => buildAgentRegistryFromEnvironment({ ...base, AI_RESEARCH_PROVIDER: 'default' }), /TAVILY_API_KEY/);
});

test('file analysis requires an explicit model privacy route and an encrypted file service', async () => {
  const fileService = {} as FileService;
  const base = { AI_GATEWAY_BASE_URL: 'https://ai.example.test/v1', AI_GATEWAY_MODEL: 'model' };
  assert.equal((await buildAgentRegistryFromEnvironment(base, undefined, undefined, fileService).readiness('FILE_ANALYSIS')).ready, false);
  const explicit = buildAgentRegistryFromEnvironment({ ...base, AI_FILE_ANALYSIS_PROVIDER: 'default' }, undefined, undefined, fileService);
  assert.equal((await explicit.readiness('FILE_ANALYSIS')).ready, false);
});

test('Chat and Model Analysis drivers preserve actual gateway provenance for callers/verifier', async () => {
  const gateway: AiGateway = {
    async isReady() { return true; },
    async generate() { return { text: 'Generated analysis', provider: 'private', model: 'model-v1', requestId: 'id-1', evidence: [{ kind: 'model_execution', provider: 'private', model: 'model-v1', modelVersion: 'v1', requestId: 'id-1', inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) }] }; },
  };
  const chat = await new ChatAgentDriver(gateway).execute({ taskId: null, userId: 'user-1', capability: 'CHAT', input: { text: 'hello', attachments: [] } });
  assert.deepEqual(chat.result, { text: 'Generated analysis' });
  const model = await new ModelAnalysisAgentDriver(gateway).execute({ taskId: 'task-1', userId: 'user-1', capability: 'MODEL_ANALYSIS', input: { text: 'analyze', attachments: [] } });
  assert.equal(verifyResult('MODEL_ANALYSIS', model).passed, true);
  assert.deepEqual(model.provenance, { provider: 'private', model: 'model-v1', requestId: 'id-1' });
});

test('Chat driver sends validated user/assistant history to the selected server-side gateway', async () => {
  let observedMessages: AiGatewayRequest['messages'] = [];
  const gateway: AiGateway = {
    async isReady() { return true; },
    async generate(request) {
      observedMessages = request.messages;
      return { text: 'The answer is 42.', provider: 'private', model: 'chat-v1', requestId: 'chat-1', evidence: [] };
    },
  };
  const conversation = [
    { role: 'user' as const, content: 'What is six times seven?' },
    { role: 'assistant' as const, content: '42.' },
    { role: 'user' as const, content: 'What was your answer?' },
  ];
  await new ChatAgentDriver(gateway).execute({
    taskId: null,
    userId: 'user-1',
    capability: 'CHAT',
    input: { text: 'What was your answer?', attachments: [] },
    conversation,
  });
  assert.deepEqual(observedMessages, conversation);
});

test('writing driver routes attachments to the File Analysis capability instead of misreporting storage readiness', async () => {
  const gateway: AiGateway = { async isReady() { return true; }, async generate() { throw new Error('must not generate'); } };
  const context: AgentExecutionContext = { taskId: 'task-1', userId: 'user-1', capability: 'WRITING', input: { text: 'Draft', attachments: ['file-id'] } };
  await assert.rejects(() => new WritingAgentDriver(gateway).execute(context), (error: unknown) => error instanceof HttpError && error.code === 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS');
});

test('Chat directs attachments to the File Analysis capability', async () => {
  const gateway: AiGateway = { async isReady() { return true; }, async generate() { throw new Error('must not call model for unsupported file content'); } };
  const context: AgentExecutionContext = { taskId: null, userId: 'user-1', capability: 'CHAT', input: { text: 'Summarize this', attachments: ['file-id'] } };
  await assert.rejects(() => new ChatAgentDriver(gateway).execute(context), (error: unknown) => error instanceof HttpError && error.code === 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS');
});

test('task planner is offline by default and uses only an explicitly selected gateway profile', () => {
  assert.ok(buildTaskPlannerFromEnvironment({}) instanceof CapabilityPlanner);
  const env = {
    AI_GATEWAY_PROVIDERS: 'local',
    AI_GATEWAY_LOCAL_BASE_URL: 'https://ai.example.test/v1',
    AI_GATEWAY_LOCAL_MODEL: 'private-planner',
    AI_PLANNER_PROVIDER: 'local',
  };
  let createdModel = '';
  const planner = buildTaskPlannerFromEnvironment(env, (config) => {
    createdModel = config.model;
    return { async isReady() { return true; }, async generate() { throw new Error('not called'); } };
  });
  assert.ok(planner instanceof ModelTaskPlanner);
  assert.equal(createdModel, 'private-planner');
  assert.throws(() => buildTaskPlannerFromEnvironment({ AI_PLANNER_PROVIDER: 'missing' }), /unconfigured AI gateway profile/);
});
