import test from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTaskGraphError, validateTaskGraph } from '../src/domain/task-graph.js';
import { CapabilityPlanner } from '../src/application/capability-planner.js';

test('task graph returns a stable topological order for dependencies', () => {
  const ordered = validateTaskGraph({
    version: 1,
    rootCapability: 'WRITING',
    nodes: [
      { id: 'final', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'final', dependsOn: ['draft'] },
      { id: 'draft', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: 'draft', dependsOn: [] },
    ],
  }, 'WRITING');
  assert.deepEqual(ordered.map((node) => node.id), ['draft', 'final']);
});

test('task graph rejects cycles, unknown dependencies, capability escalation, arbitrary operations, and multiple final nodes', () => {
  const base = { version: 1 as const, rootCapability: 'WRITING' as const };
  assert.throws(() => validateTaskGraph({ ...base, nodes: [
    { id: 'a', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: ['b'] },
    { id: 'b', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: ['a'] },
  ] }, 'WRITING'), InvalidTaskGraphError);
  assert.throws(() => validateTaskGraph({ ...base, nodes: [
    { id: 'a', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: ['missing'] },
  ] }, 'WRITING'), InvalidTaskGraphError);
  assert.throws(() => validateTaskGraph({ ...base, nodes: [
    { id: 'a', capability: 'FILE_ANALYSIS', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] },
  ] }, 'WRITING'), InvalidTaskGraphError);
  assert.throws(() => validateTaskGraph({ ...base, nodes: [
    { id: 'a', capability: 'WRITING', operation: 'EXECUTE_SHELL' as 'RUN_CAPABILITY', goal: '', dependsOn: [] },
  ] }, 'WRITING'), InvalidTaskGraphError);
  assert.throws(() => validateTaskGraph({ ...base, nodes: [
    { id: 'a', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] },
    { id: 'b', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] },
  ] }, 'WRITING'), /exactly one final node/);
});

test('offline planner creates an honest, single-capability executable plan without fabricating a task result', async () => {
  const planner = new CapabilityPlanner();
  const plan = await planner.plan({
    taskId: 'task-id', userId: 'owner', capability: 'WRITING',
    input: { text: 'Draft a welcome note', attachments: [] },
  });
  assert.equal(await planner.isReady(), true);
  assert.equal(plan.graph.rootCapability, 'WRITING');
  assert.deepEqual(plan.graph.nodes.map((node) => node.operation), ['RUN_CAPABILITY']);
  assert.deepEqual(plan.plannerEvidence, []);
  assert.deepEqual(plan.plannerProvenance, { planner: 'deterministic-capability-planner', version: 1 });
});
