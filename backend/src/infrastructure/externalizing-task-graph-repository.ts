import { Buffer } from 'node:buffer';
import { HttpError } from '../domain/errors.js';
import type { AgentResult } from '../domain/types.js';
import type { TaskGraphRepository } from '../application/orchestration-ports.js';
import { INLINE_RESULT_MAX_BYTES, type TaskArtifactMetadata, type TaskArtifactWriter } from '../application/artifact-ports.js';
import type { TaskGraphSnapshot } from '../domain/task-graph.js';

const ARTIFACT_MARKER = '__lazaynova_external_result_v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ExternalArtifactReference extends TaskArtifactMetadata {
  downloadPath: string;
}

function reference(metadata: TaskArtifactMetadata): ExternalArtifactReference {
  return { ...metadata, downloadPath: `/v1/artifacts/${metadata.artifactId}/content` };
}

function encodeResult(result: AgentResult): Buffer {
  try {
    const encoded = JSON.stringify(result);
    if (encoded === undefined) throw new Error('undefined JSON');
    return Buffer.from(encoded, 'utf8');
  } catch {
    throw new HttpError(503, 'TASK_RESULT_SERIALIZATION_FAILED', 'The task result could not be stored safely.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentResult(value: unknown): value is AgentResult {
  return isRecord(value) && Object.hasOwn(value, 'result') && Array.isArray(value.evidence);
}

function artifactIdFrom(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.result) || !isRecord(value.provenance)) return null;
  if (value.result[ARTIFACT_MARKER] !== true) return null;
  const info = value.provenance.externalResultArtifact;
  if (!isRecord(info) || typeof info.artifactId !== 'string' || !UUID_PATTERN.test(info.artifactId)) return null;
  return info.artifactId;
}

/** Replaces oversized graph-node JSONB results with verified object references and hydrates them on resume. */
export class ExternalizingTaskGraphRepository implements TaskGraphRepository {
  constructor(
    private readonly repository: TaskGraphRepository,
    private readonly artifacts: TaskArtifactWriter,
    private readonly findTaskOwner: (taskId: string) => Promise<string | null>,
  ) {}

  async loadExecutionPlan(taskId: string): Promise<TaskGraphSnapshot | null> {
    const snapshot = await this.repository.loadExecutionPlan(taskId);
    if (!snapshot) return null;
    const ownerId = await this.findTaskOwner(taskId);
    for (const node of snapshot.nodes) {
      const artifactId = artifactIdFrom(node.result);
      if (!artifactId) continue;
      if (!ownerId) throw new HttpError(404, 'TASK_NOT_FOUND', 'The task was not found.');
      const { metadata, body } = await this.artifacts.readForOwner(artifactId, ownerId);
      if (metadata.taskId !== taskId || metadata.kind !== 'GRAPH_NODE_RESULT') {
        throw new HttpError(503, 'ARTIFACT_INTEGRITY_CHECK_FAILED', 'The stored graph result reference did not match this task.');
      }
      let decoded: unknown;
      try { decoded = JSON.parse(body.toString('utf8')) as unknown; }
      catch { throw new HttpError(503, 'ARTIFACT_INTEGRITY_CHECK_FAILED', 'The stored task result could not be decoded.'); }
      if (!isAgentResult(decoded)) throw new HttpError(503, 'ARTIFACT_INTEGRITY_CHECK_FAILED', 'The stored task result has an invalid shape.');
      node.result = {
        ...decoded,
        provenance: { ...(decoded.provenance ?? {}), externalResultArtifact: reference(metadata) },
      };
    }
    return snapshot;
  }

  saveExecutionPlan(taskId: string, plan: Parameters<TaskGraphRepository['saveExecutionPlan']>[1], planHash: string): Promise<void> {
    return this.repository.saveExecutionPlan(taskId, plan, planHash);
  }

  startGraphNode(taskId: string, nodeId: string): Promise<number | null> {
    return this.repository.startGraphNode(taskId, nodeId);
  }

  async completeGraphNode(taskId: string, nodeId: string, result: AgentResult): Promise<void> {
    const encoded = encodeResult(result);
    if (encoded.byteLength <= 64 * 1_024) {
      await this.repository.completeGraphNode(taskId, nodeId, result);
      return;
    }
    const ownerId = await this.findTaskOwner(taskId);
    if (!ownerId) throw new HttpError(404, 'TASK_NOT_FOUND', 'The task was not found.');
    const metadata = await this.artifacts.storeJson({
      userId: ownerId,
      taskId,
      kind: 'GRAPH_NODE_RESULT',
      filename: `node-${nodeId}-result.json`,
      body: encoded,
    });
    const artifactReference = reference(metadata);
    const stored: AgentResult = {
      result: { [ARTIFACT_MARKER]: true },
      evidence: [],
      provenance: { externalResultArtifact: artifactReference },
    };
    try {
      await this.repository.completeGraphNode(taskId, nodeId, stored);
    } catch (error) {
      const cleaned = await this.artifacts.deleteForOwner(metadata.artifactId, ownerId).catch(() => false);
      if (!cleaned) throw new HttpError(503, 'ARTIFACT_CLEANUP_FAILED', 'An unreferenced artifact could not be removed safely.');
      throw error;
    }
    result.provenance = { ...(result.provenance ?? {}), externalResultArtifact: artifactReference };
  }

  failGraphNode(taskId: string, nodeId: string, safeCode: string): Promise<void> {
    return this.repository.failGraphNode(taskId, nodeId, safeCode);
  }

  blockGraphNode(taskId: string, nodeId: string): Promise<boolean> {
    return this.repository.blockGraphNode(taskId, nodeId);
  }

  persistEvidenceChain(taskId: string, evidence: AgentResult['evidence']): Promise<void> {
    return this.repository.persistEvidenceChain(taskId, evidence);
  }
}
