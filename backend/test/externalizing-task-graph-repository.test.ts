import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentResult } from '../src/domain/types.js';
import type { TaskGraphRepository } from '../src/application/orchestration-ports.js';
import type { TaskGraphSnapshot } from '../src/domain/task-graph.js';
import { INLINE_RESULT_MAX_BYTES, type TaskArtifactMetadata, type TaskArtifactWriter } from '../src/application/artifact-ports.js';
import { ExternalizingTaskGraphRepository } from '../src/infrastructure/externalizing-task-graph-repository.js';

const ownerId = '9e82df6f-f302-4a5b-a68a-54641af6945a';
const taskId = '7dd4d15a-11db-4f27-810f-95525e640d2d';

class FakeGraphRepository implements TaskGraphRepository {
  snapshot: TaskGraphSnapshot = {
    plan: {
      graph: { version: 1, rootCapability: 'WRITING', nodes: [{ id: 'step-1', capability: 'WRITING', operation: 'RUN_CAPABILITY', goal: '', dependsOn: [] }] },
      plannerEvidence: [],
      plannerProvenance: null,
    },
    planHash: 'a'.repeat(64),
    nodes: [],
  };
  async loadExecutionPlan() { return structuredClone(this.snapshot); }
  async saveExecutionPlan() {}
  async startGraphNode() { return 1; }
  async completeGraphNode(_taskId: string, nodeId: string, result: AgentResult) {
    const prior = this.snapshot.nodes.find((node) => node.id === nodeId);
    const node = { id: nodeId, status: 'COMPLETED' as const, attempts: 1, result: structuredClone(result) };
    this.snapshot.nodes = prior ? this.snapshot.nodes.map((item) => item.id === nodeId ? node : item) : [...this.snapshot.nodes, node];
  }
  async failGraphNode() {}
  async blockGraphNode() { return true; }
  async persistEvidenceChain() {}
}

class FakeArtifacts implements TaskArtifactWriter {
  readonly objects = new Map<string, { metadata: TaskArtifactMetadata; ownerId: string; body: Buffer }>();
  async isReady() { return true; }
  async storeJson(input: { userId: string; taskId: string; kind: 'TASK_RESULT' | 'GRAPH_NODE_RESULT'; filename: string; body: Buffer }) {
    const artifactId = randomUUID();
    const metadata: TaskArtifactMetadata = {
      artifactId, taskId: input.taskId, kind: input.kind, filename: input.filename, contentType: 'application/json',
      byteLength: input.body.length, sha256: createHash('sha256').update(input.body).digest('hex'), createdAt: '2026-10-02T00:00:00.000Z',
    };
    this.objects.set(artifactId, { metadata, ownerId: input.userId, body: Buffer.from(input.body) });
    return metadata;
  }
  async readForOwner(artifactId: string, userId: string) {
    const stored = this.objects.get(artifactId);
    if (!stored || stored.ownerId !== userId) throw new Error('not found');
    return { metadata: { ...stored.metadata }, body: Buffer.from(stored.body) };
  }
  async deleteForOwner(artifactId: string, userId: string) {
    const stored = this.objects.get(artifactId);
    if (!stored || stored.ownerId !== userId) return false;
    return this.objects.delete(artifactId);
  }
}

test('externalizing graph repository replaces oversized JSONB with a small owner-scoped reference and hydrates on resume', async () => {
  const base = new FakeGraphRepository();
  const artifacts = new FakeArtifacts();
  const repository = new ExternalizingTaskGraphRepository(base, artifacts, async (id) => id === taskId ? ownerId : null);
  const result: AgentResult = {
    result: { text: 'large generated result '.repeat(5_000) },
    evidence: [{ kind: 'model_execution', provider: 'private', model: 'model-v1' }],
    provenance: { provider: 'private', requestId: 'req-1' },
  };
  await repository.completeGraphNode(taskId, 'step-1', result);
  const stored = base.snapshot.nodes[0]?.result as AgentResult;
  assert.ok(Buffer.byteLength(JSON.stringify(stored)) < INLINE_RESULT_MAX_BYTES);
  assert.deepEqual(stored.evidence, []);
  assert.equal(artifacts.objects.size, 1);
  const artifactReference = result.provenance?.externalResultArtifact as { artifactId?: string; downloadPath?: string };
  assert.equal(typeof artifactReference.artifactId, 'string');
  assert.equal(artifactReference.downloadPath, `/v1/artifacts/${artifactReference.artifactId}/content`);

  const hydrated = await repository.loadExecutionPlan(taskId);
  const resumed = hydrated?.nodes[0]?.result as AgentResult;
  assert.deepEqual(resumed.result, result.result);
  assert.deepEqual(resumed.evidence, result.evidence);
  assert.equal((resumed.provenance?.externalResultArtifact as { artifactId: string }).artifactId, artifactReference.artifactId);
});

test('small graph results remain inline and missing task ownership prevents object access', async () => {
  const base = new FakeGraphRepository();
  const artifacts = new FakeArtifacts();
  const repository = new ExternalizingTaskGraphRepository(base, artifacts, async (id) => id === taskId ? ownerId : null);
  const small: AgentResult = { result: { text: 'small' }, evidence: [], provenance: {} };
  await repository.completeGraphNode(taskId, 'step-1', small);
  assert.deepEqual(base.snapshot.nodes[0]?.result, small);
  assert.equal(artifacts.objects.size, 0);

  const noOwner = new ExternalizingTaskGraphRepository(base, artifacts, async () => null);
  await assert.rejects(() => noOwner.completeGraphNode(taskId, 'step-1', { result: { text: 'large '.repeat(20_000) }, evidence: [] }), /not found/i);
});
