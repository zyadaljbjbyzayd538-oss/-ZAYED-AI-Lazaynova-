import test from 'node:test';
import assert from 'node:assert/strict';
import { WebResearchAgentDriver, FileAnalysisAgentDriver } from '../src/application/ai-drivers.js';
import type { AiGateway, AiGatewayRequest } from '../src/domain/ai-gateway.js';
import type { AuthRepository, AuditRepository } from '../src/application/ports.js';
import type { ResearchProvider } from '../src/application/research-ports.js';
import type { FileService } from '../src/application/file-ports.js';
import { buildCoreToolManager } from '../src/infrastructure/core-tools.js';
import { verifyResult } from '../src/domain/verifier.js';
import { HttpError } from '../src/domain/errors.js';
import type { AiUsageRecorder, ProviderUsageReport } from '../src/application/ai-usage-ports.js';
import { loadTavilySearchPrice } from '../src/infrastructure/provider-usage-accounting.js';

const modelEvidence = [{
  kind: 'model_execution', provider: 'private', model: 'model-v1', modelVersion: 'model-v1', requestId: 'model-req',
  inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64),
}];
const gateway: AiGateway = {
  async isReady() { return true; },
  async generate(request: AiGatewayRequest) {
    if (request.tools?.some((tool) => tool.name === 'web_search')) {
      assert.equal(request.toolChoice, 'required');
      return {
        text: '',
        toolCalls: [{ id: 'web-call-1', name: 'web_search', input: { query: 'model-selected query' } }],
        provider: 'private', model: 'model-v1', requestId: 'model-req', evidence: modelEvidence,
      };
    }
    return { text: 'Verified output', provider: 'private', model: 'model-v1', requestId: 'model-req', evidence: modelEvidence };
  },
};
const auditActions: string[] = [];
const auth: AuthRepository = {
  async findSessionByTokenHash() { return null; }, async createSession() {}, async createWebSocketTicket() {},
  async consumeWebSocketTicket() { return null; }, async revokeSession() {}, async findUserByEmail() { return null; },
  async findUserById() { return null; }, async createUser() { return ''; }, async grantCapability() {},
  async revokeCapability() {}, async hasCapability() { return true; },
  async grantTool() {}, async revokeTool() {}, async hasToolGrant() { return true; },
  async consumeToolUsage() { return 'ALLOWED' as const; },
  async getToolUsageStatus(_userId, _toolName, callsPerMinute, callsPerDay) {
    return { callsPerMinute, usedThisMinute: 0, minuteResetAt: '2026-10-02T12:01:00.000Z', callsPerDay, usedToday: 0, utcDayResetAt: '2026-10-03T00:00:00.000Z', serverTime: '2026-10-02T12:00:00.000Z' };
  },
  async listActiveToolGrants() { return []; },
};
const audit: AuditRepository = { async writeAudit(input) { auditActions.push(input.action); } };

test('Web Research driver uses the permission-checked, audited web.search tool and verifies retrieved source evidence', async () => {
  auditActions.length = 0;
  let searchCalls = 0;
  let searchedQuery = '';
  const search: ResearchProvider = {
    async isReady() { return true; },
    async search(query) {
      searchCalls += 1;
      searchedQuery = query;
      return {
        provider: 'search-provider', requestId: 'search-req', fetchedAt: '2026-09-29T00:00:00.000Z', rawSourceSha256: 'c'.repeat(64),
        sources: [{ title: 'Source', url: 'https://example.test/source', excerpt: 'Retrieved proof.', content: 'Retrieved source content.' }],
      };
    },
  };
  const tools = buildCoreToolManager(auth, audit, undefined, search);
  const driver = new WebResearchAgentDriver(gateway, search, tools);
  assert.equal(await driver.isReady(), true);
  const result = await driver.execute({
    taskId: 'task-1', userId: 'user-1', capability: 'WEB_RESEARCH', input: { text: 'Question', attachments: [] },
  });
  assert.equal(searchCalls, 1);
  assert.equal(searchedQuery, 'model-selected query');
  assert.equal(verifyResult('WEB_RESEARCH', result).passed, true);
  assert.equal(result.evidence.filter((item) => item.kind === 'model_execution').length, 2);
  assert.equal(result.provenance?.toolCallRequestId, 'model-req');
  assert.ok(auditActions.includes('TOOL_INVOKE_STARTED'));
  assert.ok(auditActions.includes('TOOL_INVOKE_COMPLETED'));
});

test('web.search records successful Tavily request cost against trusted owner and task without storing the query', async () => {
  const reports: ProviderUsageReport[] = [];
  const recorder: AiUsageRecorder = { async recordProviderUsage(report) { reports.push(report); } };
  const search: ResearchProvider = {
    async isReady() { return true; },
    async search() {
      return {
        provider: 'tavily', requestId: 'tavily-req-1', fetchedAt: '2026-09-29T00:00:00.000Z', rawSourceSha256: 'e'.repeat(64),
        sources: [{ title: 'Source', url: 'https://example.test/source', excerpt: 'Excerpt', content: 'Content' }],
      };
    },
  };
  const price = loadTavilySearchPrice('250000');
  const tools = buildCoreToolManager(auth, audit, undefined, search, recorder, price);
  await tools.invoke({ taskId: '7dd4d15a-11db-4f27-810f-95525e640d2d', userId: '9e82df6f-f302-4a5b-a68a-54641af6945a', capability: 'WEB_RESEARCH' }, 'web.search', { query: 'private search term' });
  assert.deepEqual(reports, [{
    userId: '9e82df6f-f302-4a5b-a68a-54641af6945a', resourceType: 'TASK', resourceId: '7dd4d15a-11db-4f27-810f-95525e640d2d', provider: 'tavily', model: 'advanced-search',
    requestId: 'tavily-req-1', usageKind: 'API_REQUEST', requestCostMicrousd: '250000', pricingVersion: price.version,
  }]);
  assert.equal(JSON.stringify(reports).includes('private search term'), false);
});

test('model-directed search cannot bypass a missing per-user tool grant', async () => {
  auditActions.length = 0;
  let searchCalls = 0;
  const restrictedAuth: AuthRepository = {
    ...auth,
    async hasToolGrant() { return false; },
  };
  const search: ResearchProvider = {
    async isReady() { return true; },
    async search() {
      searchCalls += 1;
      throw new Error('must not be invoked');
    },
  };
  const tools = buildCoreToolManager(restrictedAuth, audit, undefined, search);
  const driver = new WebResearchAgentDriver(gateway, search, tools);
  await assert.rejects(() => driver.execute({
    taskId: 'task-denied', userId: 'user-denied', capability: 'WEB_RESEARCH', input: { text: 'Search this', attachments: [] },
  }), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_PERMISSION_DENIED');
  assert.equal(searchCalls, 0);
  assert.ok(auditActions.includes('TOOL_PERMISSION_DENIED'));
});

test('File Analysis driver uses the owner-scoped file.read_text tool before model analysis', async () => {
  const expected = {
    fileId: '123e4567-e89b-42d3-a456-426614174000', filename: 'report.txt', contentType: 'text/plain' as const,
    byteLength: 12, sha256: 'd'.repeat(64), createdAt: '2026-09-29T00:00:00.000Z', kind: 'TXT' as const,
    text: 'Revenue rose.', extractorVersion: 'utf8-text-v1', parsedPages: 1, excerpt: 'Revenue rose.',
  };
  let parseOwner = '';
  let parseFileId = '';
  const files: FileService = {
    async isReady() { return true; },
    async createUpload() { throw new Error('unused'); },
    async getMetadata() { throw new Error('unused'); },
    async parseForAnalysis(input) { parseOwner = input.userId; parseFileId = input.fileId; return expected; },
    async delete() { return false; },
  };
  auditActions.length = 0;
  const tools = buildCoreToolManager(auth, audit, files, undefined);
  const driver = new FileAnalysisAgentDriver(gateway, files, tools);
  assert.equal(await driver.isReady(), true);
  const result = await driver.execute({
    taskId: 'task-2', userId: 'user-owner', capability: 'FILE_ANALYSIS',
    input: { text: 'Summarize', attachments: [expected.fileId] },
  });
  assert.equal(parseOwner, 'user-owner');
  assert.equal(parseFileId, expected.fileId);
  assert.equal(verifyResult('FILE_ANALYSIS', result).passed, true);
  assert.ok(auditActions.includes('TOOL_INVOKE_COMPLETED'));
});
