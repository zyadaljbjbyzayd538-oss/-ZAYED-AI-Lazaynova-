import test from 'node:test';
import assert from 'node:assert/strict';
import { AiModelCatalog } from '../src/application/ai-model-catalog.js';
import { buildAiModelCatalogFromEnvironment } from '../src/infrastructure/agent-composition.js';
import { buildApp } from '../src/api/app.js';
import { AgentRegistry } from '../src/domain/agent-registry.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../src/application/ports.js';
import type { SubmitAssistantRequest } from '../src/application/submit-request.js';
import type { SessionService } from '../src/auth/session-service.js';
import type { AuthenticatedUser } from '../src/domain/types.js';

const user: AuthenticatedUser = { id: '9e82df6f-f302-4a5b-a68a-54641af6945a', email: 'user@example.test', role: 'USER', sessionId: 'user-session' };
const admin: AuthenticatedUser = { id: '3512c44b-8119-488e-85c0-d1b035f6857f', email: 'admin@example.test', role: 'ADMIN', sessionId: 'admin-session' };
const userHeaders = { authorization: `Bearer ${'u'.repeat(40)}` };
const adminHeaders = { authorization: `Bearer ${'a'.repeat(40)}` };

function appWithCatalog(catalog: AiModelCatalog) {
  return buildApp({
    sessions: { async authenticate(token: string) { return token === 'a'.repeat(40) ? admin : user; } } as unknown as SessionService,
    auth: {} as AuthRepository,
    tasks: {} as TaskRepository,
    audit: { async writeAudit() {} } as AuditRepository,
    submit: {} as SubmitAssistantRequest,
    agents: new AgentRegistry(),
    aiModelCatalog: catalog,
    logger: false,
  });
}

test('model catalog reports real provider availability, keeps safe failures, and caches provider probes briefly', async () => {
  let localCalls = 0;
  let failedCalls = 0;
  const catalog = new AiModelCatalog([
    {
      profileName: 'local', configuredModel: 'qwen-local', assignedCapabilities: ['CHAT'],
      async listAvailableModels() { localCalls += 1; return ['qwen-local', 'qwen-small', 'qwen-local', 'bad\u0000id', 'x'.repeat(201)]; },
    },
    {
      profileName: 'cloud', configuredModel: 'gpt-approved', assignedCapabilities: ['WRITING'],
      async listAvailableModels() { return ['other-model']; },
    },
    {
      profileName: 'offline', configuredModel: 'private-model', assignedCapabilities: ['MODEL_ANALYSIS'],
      async listAvailableModels() { failedCalls += 1; throw new Error('secret endpoint/key details'); },
    },
  ], 10_000);

  const inventories = await catalog.listProviderInventories();
  assert.deepEqual(inventories.map((item) => item.availability), ['AVAILABLE', 'CONFIGURED_MODEL_MISSING', 'UNREACHABLE']);
  assert.deepEqual(inventories[0]?.availableModels, ['qwen-local', 'qwen-small']);
  assert.equal(JSON.stringify(inventories).includes('secret endpoint/key details'), false);
  assert.deepEqual(await catalog.listRoutedModels(), [
    { capability: 'CHAT', model: 'qwen-local', available: true },
    { capability: 'MODEL_ANALYSIS', model: 'private-model', available: false },
    { capability: 'WRITING', model: 'gpt-approved', available: false },
  ]);
  await catalog.listProviderInventories();
  assert.equal(localCalls, 1);
  assert.equal(failedCalls, 1);
});

test('catalog preserves the configured model in its 100-item admin inventory cap', async () => {
  const catalog = new AiModelCatalog([{
    profileName: 'many-models', configuredModel: 'z-selected-model', assignedCapabilities: ['CHAT'],
    async listAvailableModels() { return [...Array.from({ length: 110 }, (_, index) => `model-${String(index).padStart(3, '0')}`), 'z-selected-model']; },
  }]);
  const [inventory] = await catalog.listProviderInventories();
  assert.equal(inventory?.availableModels.length, 100);
  assert.equal(inventory?.availableModels.includes('z-selected-model'), true);
  assert.equal(inventory?.availability, 'AVAILABLE');
});

test('environment catalog uses the same explicit capability routes and never returns endpoints or API keys', async () => {
  const env = {
    AI_GATEWAY_PROVIDERS: 'local,cloud',
    AI_GATEWAY_LOCAL_BASE_URL: 'http://ollama.internal:11434/v1',
    AI_GATEWAY_LOCAL_MODEL: 'qwen-local',
    AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP: 'true',
    AI_GATEWAY_CLOUD_BASE_URL: 'https://vendor.internal/v1',
    AI_GATEWAY_CLOUD_MODEL: 'gpt-approved',
    AI_GATEWAY_CLOUD_API_KEY: 'secret-cloud-key',
    AI_CHAT_PROVIDER: 'local',
    AI_WRITING_PROVIDER: 'local',
    AI_MODEL_ANALYSIS_PROVIDER: 'cloud',
    AI_RESEARCH_PROVIDER: 'cloud',
    AI_FILE_ANALYSIS_PROVIDER: 'local',
    AI_PLANNER_PROVIDER: 'cloud',
  };
  const catalog = buildAiModelCatalogFromEnvironment(env, (config) => ({
    async listModels() { return [config.model, 'another-model']; },
  }));
  const inventory = await catalog.listProviderInventories();
  const local = inventory.find((profile) => profile.profileName === 'local');
  const cloud = inventory.find((profile) => profile.profileName === 'cloud');
  assert.deepEqual(local?.assignedCapabilities, ['CHAT', 'FILE_ANALYSIS', 'WRITING']);
  assert.deepEqual(cloud?.assignedCapabilities, ['MODEL_ANALYSIS', 'TASK_PLANNER', 'WEB_RESEARCH']);
  const serialized = JSON.stringify(inventory);
  assert.equal(serialized.includes('secret-cloud-key'), false);
  assert.equal(serialized.includes('vendor.internal'), false);
  assert.equal(serialized.includes('ollama.internal'), false);
});

test('model discovery endpoints authenticate callers and restrict provider inventory to administrators', async () => {
  const catalog = new AiModelCatalog([
    {
      profileName: 'private', configuredModel: 'qwen-local', assignedCapabilities: ['CHAT'],
      async listAvailableModels() { return ['qwen-local']; },
    },
  ], 0);
  const app = await appWithCatalog(catalog);
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/ai/models' });
    assert.equal(unauthenticated.statusCode, 401);

    const userModels = await app.inject({ method: 'GET', url: '/v1/ai/models', headers: userHeaders });
    assert.equal(userModels.statusCode, 200);
    assert.deepEqual(userModels.json().models, [{ capability: 'CHAT', model: 'qwen-local', available: true }]);

    const forbidden = await app.inject({ method: 'GET', url: '/v1/admin/ai/models', headers: userHeaders });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, 'ADMIN_ROLE_REQUIRED');

    const adminView = await app.inject({ method: 'GET', url: '/v1/admin/ai/models', headers: adminHeaders });
    assert.equal(adminView.statusCode, 200);
    assert.deepEqual(adminView.json().providers[0].availableModels, ['qwen-local']);
    assert.equal(JSON.stringify(adminView.json()).includes('apiKey'), false);
  } finally {
    await app.close();
  }
});
