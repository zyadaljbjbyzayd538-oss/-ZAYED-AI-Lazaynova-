import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { AuthenticatedUser } from '../src/domain/types.js';
import type { AiGatewayStreamEvent } from '../src/domain/ai-gateway.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import { HttpError } from '../src/domain/errors.js';

const user: AuthenticatedUser = {
  id: '9e82df6f-f302-4a5b-a68a-54641af6945a',
  email: 'user@example.test',
  role: 'USER',
  sessionId: 'session-1',
};
const headers = { authorization: `Bearer ${'t'.repeat(40)}` };

function streamOf(...events: AiGatewayStreamEvent[]): AsyncIterable<AiGatewayStreamEvent> {
  return (async function* () { yield* events; })();
}

function streamThenThrow(error: Error): AsyncIterable<AiGatewayStreamEvent> {
  return (async function* () {
    yield { type: 'text_delta', content: 'partial response' };
    throw error;
  })();
}

async function makeApp(streamChat: SubmitAssistantRequest['streamChat']) {
  return buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: { streamChat } as unknown as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    rateLimit: { max: 100, timeWindow: '1 minute' },
    logger: false,
  });
}

test('Lazaynova SSE endpoint forwards real text deltas and provider provenance', async () => {
  let observed: { userId: string; prompt: string; hasAbortSignal: boolean } | null = null;
  const app = await makeApp(async (authenticatedUser, input, signal) => {
    observed = { userId: authenticatedUser.id, prompt: input.text, hasAbortSignal: signal instanceof AbortSignal };
    return streamOf(
      { type: 'text_delta', content: 'Generated ' },
      { type: 'text_delta', content: 'by the configured model.' },
      {
        type: 'completed', provider: 'configured-profile', model: 'server-routed-model', requestId: 'request-123',
        usage: { inputTokens: 11, outputTokens: 7 }, evidence: [],
      },
    );
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/lazaynova/chat/stream', headers, payload: { prompt: 'Write a short greeting.' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] ?? '', /^text\/event-stream/);
    assert.match(response.body, /event: start\ndata: \{"status":"started"\}/);
    assert.match(response.body, /event: delta\ndata: \{"content":"Generated "\}/);
    assert.match(response.body, /event: delta\ndata: \{"content":"by the configured model\."\}/);
    assert.match(response.body, /event: result\ndata: \{"provenance":\{"provider":"configured-profile","model":"server-routed-model","requestId":"request-123","usage":\{"inputTokens":11,"outputTokens":7\}\}\}/);
    assert.match(response.body, /event: done\ndata: \[DONE\]/);
    assert.deepEqual(observed, { userId: user.id, prompt: 'Write a short greeting.', hasAbortSignal: true });
    assert.doesNotMatch(response.body, /processed successfully|Lazaynova Engine Response/);
  } finally {
    await app.close();
  }
});

test('Lazaynova SSE endpoint preserves bounded user/assistant transcript history', async () => {
  let observedMessages: unknown = null;
  const app = await makeApp(async (_authenticatedUser, input) => {
    observedMessages = input.messages;
    return streamOf(
      { type: 'text_delta', content: 'The earlier answer was 42.' },
      { type: 'completed', provider: 'test', model: 'test-model', requestId: 'test-request', evidence: [] },
    );
  });
  try {
    const messages = [
      { role: 'user', content: 'What is six times seven?' },
      { role: 'assistant', content: '42.' },
      { role: 'user', content: 'What was your answer?' },
    ];
    const response = await app.inject({
      method: 'POST', url: '/v1/lazaynova/chat/stream', headers, payload: { messages },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(observedMessages, messages);
  } finally {
    await app.close();
  }
});

test('Lazaynova SSE endpoint requires bearer-session authentication', async () => {
  let called = false;
  const app = await makeApp(async () => {
    called = true;
    return streamOf();
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/v1/lazaynova/chat/stream', payload: { prompt: 'Hello' } });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test('Lazaynova SSE endpoint rejects client model selection and arbitrary fields', async () => {
  let called = false;
  const app = await makeApp(async () => {
    called = true;
    return streamOf();
  });
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/lazaynova/chat/stream', headers,
      payload: { prompt: 'Hello', model: 'lazaynova-coder-pro' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REQUEST');
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test('Lazaynova SSE endpoint converts safe provider failures to SSE error events', async () => {
  const app = await makeApp(async () => streamThenThrow(
    new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.'),
  ));
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/lazaynova/chat/stream', headers, payload: { prompt: 'Hello' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: error\ndata: \{"code":"AI_GATEWAY_REQUEST_FAILED"/);
    assert.doesNotMatch(response.body, /event: done/);
  } finally {
    await app.close();
  }
});

test('Lazaynova SSE endpoint hides unexpected backend exception details', async () => {
  const app = await makeApp(async () => streamThenThrow(new Error('provider secret and raw upstream body')));
  try {
    const response = await app.inject({
      method: 'POST', url: '/v1/lazaynova/chat/stream', headers, payload: { prompt: 'Hello' },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: error\ndata: \{"code":"INTERNAL_ERROR","message":"An internal error occurred\."\}/);
    assert.doesNotMatch(response.body, /provider secret|raw upstream body/);
  } finally {
    await app.close();
  }
});
