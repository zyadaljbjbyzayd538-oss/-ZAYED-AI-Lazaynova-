import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelTaskPlanner } from '../src/application/model-task-planner.js';
import type { AiGateway, AiGatewayRequest, AiGatewayResponse } from '../src/domain/ai-gateway.js';
import { HttpError } from '../src/domain/errors.js';

class FakeGateway implements AiGateway {
  requests: AiGatewayRequest[] = [];
  responseText = '';
  evidence: AiGatewayResponse['evidence'] = [{ kind: 'model_execution', provider: 'private', model: 'planner', requestId: 'req-1' }];
  async isReady(): Promise<boolean> { return true; }
  async generate(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    this.requests.push(request);
    return { text: this.responseText, provider: 'private', model: 'planner', requestId: 'req-1', evidence: this.evidence };
  }
}

const context = {
  taskId: 'task-1', userId: 'owner', capability: 'WRITING' as const,
  input: { text: 'Create a draft', attachments: ['file-id-not-forwarded'] },
};

test('model planner returns a validated same-capability DAG and passes actual provider provenance', async () => {
  const gateway = new FakeGateway();
  gateway.responseText = JSON.stringify({
    version: 1,
    rootCapability: 'WRITING',
    nodes: [
      { id: 'draft', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'Draft the requested content', dependsOn: [] },
      { id: 'revise', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'Revise using the draft', dependsOn: ['draft'] },
    ],
  });
  const planner = new ModelTaskPlanner(gateway);
  const plan = await planner.plan(context);
  assert.equal(await planner.isReady(), true);
  assert.equal(plan.graph.nodes.length, 2);
  assert.deepEqual(plan.plannerProvenance, { provider: 'private', model: 'planner', requestId: 'req-1' });
  assert.equal(gateway.requests[0]?.messages[0]?.content.includes('file-id-not-forwarded'), false);
  assert.equal(gateway.requests[0]?.messages[0]?.content.includes('attachmentCount'), true);
});

test('model planner rejects cross-capability, malformed, and multi-node file plans', async () => {
  const gateway = new FakeGateway();
  const planner = new ModelTaskPlanner(gateway);
  gateway.responseText = JSON.stringify({ version: 1, rootCapability: 'FILE_ANALYSIS', nodes: [
    { id: 'research', capability: 'WEB_RESEARCH', operation: 'RUN_CAPABILITY', goal: 'search', dependsOn: [] },
  ] });
  await assert.rejects(() => planner.plan({ ...context, capability: 'FILE_ANALYSIS' }), (error: unknown) => error instanceof HttpError && error.code === 'PLANNER_OUTPUT_INVALID');

  gateway.responseText = JSON.stringify({ version: 1, rootCapability: 'FILE_ANALYSIS', nodes: [
    { id: 'a', capability: 'FILE_ANALYSIS', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] },
    { id: 'b', capability: 'FILE_ANALYSIS', operation: 'RUN_CAPABILITY', goal: '', dependsOn: ['a'] },
  ] });
  await assert.rejects(() => planner.plan({ ...context, capability: 'FILE_ANALYSIS' }), (error: unknown) => error instanceof HttpError && error.code === 'PLANNER_OUTPUT_INVALID');
});

test('model planner requires verifiable evidence and never manufactures a fallback graph', async () => {
  const gateway = new FakeGateway();
  gateway.responseText = JSON.stringify({ version: 1, rootCapability: 'WRITING', nodes: [
    { id: 'draft', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] },
  ] });
  gateway.evidence = [];
  await assert.rejects(() => new ModelTaskPlanner(gateway).plan(context), (error: unknown) => error instanceof HttpError && error.code === 'PLANNER_EVIDENCE_MISSING');
});
