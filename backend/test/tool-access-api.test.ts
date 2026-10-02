import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/api/app.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { SessionService } from '../src/auth/session-service.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthenticatedUser, ToolName } from '../src/domain/types.js';

const user: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'user@example.test', role: 'USER', sessionId: 'session-user' };
const admin: AuthenticatedUser = { id: '3512c44b-8119-488e-85c0-d1b035f6857f', email: 'admin@example.test', role: 'ADMIN', sessionId: 'session-admin' };
const userHeaders = { authorization: `Bearer ${'u'.repeat(40)}` };
const adminHeaders = { authorization: `Bearer ${'a'.repeat(40)}` };
const targetId = '4412c44b-8119-488e-85c0-d1b035f6857f';

test('tool grant administration enforces admin role and a matching capability grant', async () => {
  let capabilityGranted = false;
  const grants: Array<{ action: string; userId: string; toolName: ToolName }> = [];
  const auth = {
    async hasCapability(_userId: string, capability: string) { return capability === 'WEB_RESEARCH' && capabilityGranted; },
    async hasToolGrant() { return false; },
    async findUserById(id: string) { return id === targetId ? { id, email: user.email, role: 'USER' as const } : null; },
    async listActiveToolGrants() { return [{ toolName: 'web.search' as const, grantedAt: '2026-09-30T00:00:00.000Z', expiresAt: null }]; },
    async grantTool(userId: string, toolName: ToolName) { grants.push({ action: 'grant', userId, toolName }); },
    async revokeTool(userId: string, toolName: ToolName) { grants.push({ action: 'revoke', userId, toolName }); },
  } as unknown as AuthRepository;
  const app = await buildApp({
    sessions: { async authenticate(token: string) { return token === 'a'.repeat(40) ? admin : user; } } as unknown as SessionService,
    auth,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    tools: {
      async isToolReady() { return true; },
      async listAvailable(userId: string) { return userId === user.id ? [{ name: 'web.search', description: 'Search approved web sources.' }] : []; },
      async invoke() { return null; },
    },
    logger: false,
  });
  try {
    const nonAdmin = await app.inject({ method: 'GET', url: '/v1/admin/tools', headers: userHeaders });
    assert.equal(nonAdmin.statusCode, 403);
    assert.equal(nonAdmin.json().error.code, 'ADMIN_ROLE_REQUIRED');

    const catalog = await app.inject({ method: 'GET', url: '/v1/admin/tools', headers: adminHeaders });
    assert.equal(catalog.statusCode, 200);
    assert.deepEqual(catalog.json().tools, [
      { name: 'web.search', requiredCapability: 'WEB_RESEARCH', budget: { callsPerMinute: 20, callsPerDay: 200 }, configured: true },
      { name: 'file.read_text', requiredCapability: 'FILE_ANALYSIS', budget: { callsPerMinute: 30, callsPerDay: 500 }, configured: true },
    ]);

    const requiresCapability = await app.inject({
      method: 'PUT', url: `/v1/admin/users/${targetId}/tools/web.search`, headers: adminHeaders, payload: { enabled: true },
    });
    assert.equal(requiresCapability.statusCode, 409);
    assert.equal(requiresCapability.json().error.code, 'TOOL_REQUIRES_CAPABILITY_GRANT');
    assert.deepEqual(grants, []);

    capabilityGranted = true;
    const granted = await app.inject({
      method: 'PUT', url: `/v1/admin/users/${targetId}/tools/web.search`, headers: adminHeaders, payload: { enabled: true },
    });
    assert.equal(granted.statusCode, 204);
    const revoked = await app.inject({
      method: 'PUT', url: `/v1/admin/users/${targetId}/tools/web.search`, headers: adminHeaders, payload: { enabled: false },
    });
    assert.equal(revoked.statusCode, 204);
    assert.deepEqual(grants, [
      { action: 'grant', userId: targetId, toolName: 'web.search' },
      { action: 'revoke', userId: targetId, toolName: 'web.search' },
    ]);

    const listed = await app.inject({ method: 'GET', url: `/v1/admin/users/${targetId}/tools`, headers: adminHeaders });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().grants[0].toolName, 'web.search');

    const invalidTool = await app.inject({
      method: 'PUT', url: `/v1/admin/users/${targetId}/tools/shell.exec`, headers: adminHeaders, payload: { enabled: true },
    });
    assert.equal(invalidTool.statusCode, 400);
    assert.equal(invalidTool.json().error.code, 'INVALID_TOOL');
  } finally {
    await app.close();
  }
});

test('user tool endpoints expose only tools both granted and ready for that user', async () => {
  const app = await buildApp({
    sessions: { async authenticate() { return user; } } as unknown as SessionService,
    auth: {
      async hasCapability(_userId: string, capability: string) { return capability === 'WEB_RESEARCH'; },
      async hasToolGrant(_userId: string, toolName: string) { return toolName === 'web.search'; },
      async getToolUsageStatus(_userId: string, _toolName: ToolName, callsPerMinute: number, callsPerDay: number) {
        return {
          callsPerMinute, usedThisMinute: 3, minuteResetAt: '2026-10-02T12:01:00.000Z',
          callsPerDay, usedToday: 42, utcDayResetAt: '2026-10-03T00:00:00.000Z', serverTime: '2026-10-02T12:00:30.000Z',
        };
      },
    } as unknown as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    tools: {
      async isToolReady() { return true; },
      async listAvailable(userId: string) { return userId === user.id ? [{ name: 'web.search', description: 'Search approved web sources.' }] : []; },
      async invoke() { return null; },
    },
    logger: false,
  });
  try {
    const result = await app.inject({ method: 'GET', url: '/v1/agent/tools', headers: userHeaders });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.json().tools, [{ name: 'web.search', description: 'Search approved web sources.' }]);

    const capabilities = await app.inject({ method: 'GET', url: '/v1/agent/capabilities', headers: userHeaders });
    assert.equal(capabilities.statusCode, 200);
    assert.equal(capabilities.headers['cache-control'], 'no-store');
    const research = capabilities.json().capabilities.find((item: { capability: string }) => item.capability === 'WEB_RESEARCH');
    assert.deepEqual(research.toolGrants, [{
      name: 'web.search',
      granted: true,
      usage: {
        callsPerMinute: 20, usedThisMinute: 3, minuteResetAt: '2026-10-02T12:01:00.000Z',
        callsPerDay: 200, usedToday: 42, utcDayResetAt: '2026-10-03T00:00:00.000Z', serverTime: '2026-10-02T12:00:30.000Z',
      },
    }]);
  } finally {
    await app.close();
  }
});
