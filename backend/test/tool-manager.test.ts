import test from 'node:test';
import assert from 'node:assert/strict';
import { AllowlistedToolManager, type AllowlistedTool } from '../src/application/tool-manager.js';
import type { AuditRepository, AuthRepository } from '../src/application/ports.js';
import type { ToolInvocationContext } from '../src/application/orchestration-ports.js';
import { HttpError } from '../src/domain/errors.js';
import { TOOL_BUDGETS, type ToolUsageDecision } from '../src/domain/types.js';

const context: ToolInvocationContext = { taskId: 'task-1', userId: 'user-1', capability: 'WEB_RESEARCH' };

function makeManager(options: { granted?: boolean; toolGranted?: boolean; usageDecision?: ToolUsageDecision; timeoutMilliseconds?: number; execute?: AllowlistedTool['execute'] } = {}) {
  const audits: Array<{ action: string; details: Record<string, unknown> }> = [];
  const auth: AuthRepository = {
    async findSessionByTokenHash() { return null; }, async createSession() {}, async createWebSocketTicket() {},
    async consumeWebSocketTicket() { return null; }, async revokeSession() {}, async findUserByEmail() { return null; },
    async findUserById() { return null; }, async createUser() { return ''; }, async grantCapability() {},
    async revokeCapability() {}, async hasCapability() { return options.granted ?? true; },
    async grantTool() {}, async revokeTool() {}, async hasToolGrant() { return options.toolGranted ?? true; },
    async consumeToolUsage() { return options.usageDecision ?? 'ALLOWED'; },
    async listActiveToolGrants() { return []; },
  };
  const audit: AuditRepository = { async writeAudit(input) { audits.push({ action: input.action, details: input.details }); } };
  const tool: AllowlistedTool<{ query: string }, { count: number }> = {
    name: 'web.search', description: 'Search approved web sources.', requiredCapability: 'WEB_RESEARCH',
    timeoutMilliseconds: options.timeoutMilliseconds ?? 1_000,
    callsPerMinute: TOOL_BUDGETS['web.search'].callsPerMinute,
    callsPerDay: TOOL_BUDGETS['web.search'].callsPerDay,
    async isReady() { return true; },
    parseInput(value) {
      if (!value || typeof value !== 'object' || typeof (value as { query?: unknown }).query !== 'string') throw new Error('bad input');
      return { query: (value as { query: string }).query };
    },
    async execute(ctx, input, signal) {
      if (options.execute) return options.execute(ctx, input, signal) as Promise<{ count: number }>;
      return { count: input.query.length };
    },
  };
  return { manager: new AllowlistedToolManager(auth, audit, [tool]), audits };
}

test("tool manager exposes only ready tools with both capability and separate tool grants", async () => {
  const capabilityDenied = makeManager({ granted: false }).manager;
  assert.deepEqual(await capabilityDenied.listAvailable('user-1'), []);
  const toolDenied = makeManager({ toolGranted: false }).manager;
  assert.deepEqual(await toolDenied.listAvailable('user-1'), []);
  const authorized = makeManager({ granted: true, toolGranted: true }).manager;
  assert.deepEqual(await authorized.listAvailable('user-1'), [{ name: 'web.search', description: 'Search approved web sources.' }]);
});

test('tool invocation validates allowlist, task capability, owner grant, and input before executing', async () => {
  const { manager, audits } = makeManager();
  assert.equal(await manager.invoke(context, 'web.search', { query: 'weather' }).then((result) => (result as { count: number }).count), 7);
  await assert.rejects(() => manager.invoke(context, 'shell.exec', {}), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_NOT_FOUND');
  await assert.rejects(() => manager.invoke({ ...context, capability: 'WRITING' }, 'web.search', { query: 'x' }), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_PERMISSION_DENIED');
  await assert.rejects(() => manager.invoke(context, 'web.search', { query: 4 }), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_INPUT_INVALID');
  assert.equal(audits.some((entry) => entry.action === 'TOOL_INVOKE_COMPLETED'), true);
  assert.equal(JSON.stringify(audits).includes('weather'), false);
});

test('tool invocation re-checks grants for every call and writes a denial audit record', async () => {
  const { manager, audits } = makeManager({ granted: false });
  await assert.rejects(() => manager.invoke(context, 'web.search', { query: 'private question' }), (error: unknown) => error instanceof HttpError && error.statusCode === 403);
  assert.equal(audits.some((entry) => entry.action === 'TOOL_PERMISSION_DENIED'), true);
  assert.equal(JSON.stringify(audits).includes('private question'), false);
});

test('tool manager re-checks the distinct tool grant at invocation and audits a denial without the query', async () => {
  const { manager, audits } = makeManager({ granted: true, toolGranted: false });
  await assert.rejects(() => manager.invoke(context, 'web.search', { query: 'restricted term' }), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_PERMISSION_DENIED');
  assert.equal(audits.some((entry) => entry.action === 'TOOL_PERMISSION_DENIED' && entry.details.reason === 'TOOL_GRANT_MISSING'), true);
  assert.equal(JSON.stringify(audits).includes('restricted term'), false);
});

test('tool manager enforces durable minute/day budgets and audits exhaustion without input', async () => {
  for (const usageDecision of ['MINUTE_LIMIT', 'DAILY_LIMIT'] as const) {
    let executed = false;
    const { manager, audits } = makeManager({ usageDecision, execute: async () => { executed = true; return { count: 0 }; } });
    await assert.rejects(
      () => manager.invoke(context, 'web.search', { query: 'budgeted private query' }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 429 && error.code === 'TOOL_BUDGET_EXHAUSTED',
    );
    assert.equal(executed, false);
    assert.ok(audits.some((entry) => entry.action === 'TOOL_BUDGET_EXHAUSTED' && entry.details.window === usageDecision));
    assert.equal(JSON.stringify(audits).includes('budgeted private query'), false);
  }
});

test('tool execution is bounded by an aborting timeout and returns a safe timeout error', async () => {
  let aborted = false;
  const { manager } = makeManager({
    timeoutMilliseconds: 100,
    execute: (_ctx, _input, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('upstream secret')); }, { once: true });
    }),
  });
  await assert.rejects(() => manager.invoke(context, 'web.search', { query: 'slow' }), (error: unknown) => error instanceof HttpError && error.code === 'TOOL_TIMEOUT');
  assert.equal(aborted, true);
});

test('tool manager rejects duplicate names and invalid timeout budgets at startup', () => {
  const tool: AllowlistedTool = {
    name: 'file.read_text', description: 'Read one encrypted file.', requiredCapability: 'FILE_ANALYSIS', timeoutMilliseconds: 100,
    callsPerMinute: TOOL_BUDGETS['file.read_text'].callsPerMinute,
    callsPerDay: TOOL_BUDGETS['file.read_text'].callsPerDay,
    async isReady() { return true; }, parseInput: (input) => input, async execute() { return null; },
  };
  const auth = { async hasCapability() { return true; }, async hasToolGrant() { return true; } } as unknown as AuthRepository;
  const audit = { async writeAudit() {} } as AuditRepository;
  assert.throws(() => new AllowlistedToolManager(auth, audit, [tool, tool]), /duplicate tool name/);
  assert.throws(() => new AllowlistedToolManager(auth, audit, [{ ...tool, requiredCapability: 'WEB_RESEARCH' }]), /reviewed capability mapping/);
  assert.throws(() => new AllowlistedToolManager(auth, audit, [{ ...tool, timeoutMilliseconds: 1 }]), /invalid timeout/);
});
