import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthenticatedUser } from '../src/domain/types.js';
import type { SessionService } from '../src/auth/session-service.js';

const userId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const otherUserId = '3512c44b-8119-488e-85c0-d1b035f6857f';
const usage = {
  currency: 'USD' as const,
  requestCount: '3',
  reportedUsageCount: '2',
  unreportedUsageCount: '1',
  nonTokenRequestCount: '0',
  pricedRequestCount: '1',
  unpricedRequestCount: '2',
  inputTokens: '300',
  outputTokens: '90',
  costMicrousd: '42',
  pricingVersions: ['a'.repeat(64)],
};

function makeUser(id: string, role: 'USER' | 'ADMIN'): AuthenticatedUser {
  return { id, email: `${role.toLowerCase()}@example.test`, role, sessionId: `${role}-session` };
}

test('GET /v1/usage returns the authenticated user summary and rejects unauthenticated access', async () => {
  const seen: string[] = [];
  const app = await buildApp({
    sessions: { async authenticate(token: string) { return token === 'u'.repeat(40) ? makeUser(userId, 'USER') : null; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: {} as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: {} as AgentRegistry,
    aiUsage: { async getUserUsageSummary(id: string) { seen.push(id); return usage; } },
    logger: false,
  });
  try {
    const missing = await app.inject({ method: 'GET', url: '/v1/usage' });
    assert.equal(missing.statusCode, 401);
    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${'u'.repeat(40)}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), usage);
    assert.deepEqual(seen, [userId]);
  } finally { await app.close(); }
});

test('admin usage endpoint is role-gated and owner-id validated before reading another account', async () => {
  const seen: string[] = [];
  const app = await buildApp({
    sessions: { async authenticate(token: string) {
      if (token === 'u'.repeat(40)) return makeUser(userId, 'USER');
      if (token === 'a'.repeat(40)) return makeUser(otherUserId, 'ADMIN');
      return null;
    } } as unknown as SessionService,
    auth: { async findUserById(id: string) { return id === userId ? makeUser(userId, 'USER') : null; } } as unknown as AuthRepository,
    tasks: {} as TaskRepository,
    audit: {} as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: {} as AgentRegistry,
    aiUsage: { async getUserUsageSummary(id: string) { seen.push(id); return usage; } },
    logger: false,
  });
  try {
    const userDenied = await app.inject({
      method: 'GET', url: `/v1/admin/users/${userId}/usage`, headers: { authorization: `Bearer ${'u'.repeat(40)}` },
    });
    assert.equal(userDenied.statusCode, 403);
    const invalidId = await app.inject({
      method: 'GET', url: '/v1/admin/users/not-a-uuid/usage', headers: { authorization: `Bearer ${'a'.repeat(40)}` },
    });
    assert.equal(invalidId.statusCode, 400);
    const response = await app.inject({
      method: 'GET', url: `/v1/admin/users/${userId}/usage`, headers: { authorization: `Bearer ${'a'.repeat(40)}` },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(seen, [userId]);
    const missing = await app.inject({
      method: 'GET', url: `/v1/admin/users/${otherUserId}/usage`, headers: { authorization: `Bearer ${'a'.repeat(40)}` },
    });
    assert.equal(missing.statusCode, 404);
  } finally { await app.close(); }
});

test('usage routes fail closed when usage storage is not configured', async () => {
  const app = await buildApp({
    sessions: { async authenticate() { return makeUser(userId, 'USER'); } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: {} as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: {} as AgentRegistry,
    logger: false,
  });
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/usage', headers: { authorization: `Bearer ${'u'.repeat(40)}` } });
    assert.equal(response.statusCode, 501);
    assert.equal(response.json().error.code, 'AI_USAGE_UNAVAILABLE');
  } finally { await app.close(); }
});
