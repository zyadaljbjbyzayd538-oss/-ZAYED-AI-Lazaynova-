import type { Readable } from 'node:stream';

export const INLINE_RESULT_MAX_BYTES = 64 * 1_024;
export const MAX_TASK_ARTIFACT_BYTES = 25 * 1_024 * 1_024;
export const TASK_ARTIFACT_CONTENT_TYPE = 'application/json';

export type TaskArtifactKind = 'TASK_RESULT' | 'GRAPH_NODE_RESULT';

export interface TaskArtifactMetadata {
  artifactId: string;
  taskId: string;
  kind: TaskArtifactKind;
  filename: string;
  contentType: typeof TASK_ARTIFACT_CONTENT_TYPE;
  byteLength: number;
  sha256: string;
  createdAt: string;
}

export interface TaskArtifactReference extends TaskArtifactMetadata {
  downloadPath: string;
}

export interface TaskArtifactRecord extends TaskArtifactMetadata {
  userId: string;
  objectKey: string;
}

export interface TaskArtifactRepository {
  createArtifact(input: Omit<TaskArtifactRecord, 'createdAt'>): Promise<TaskArtifactMetadata>;
  findArtifactForOwner(artifactId: string, userId: string): Promise<TaskArtifactRecord | null>;
  markArtifactDeleting(artifactId: string, userId: string): Promise<string | null>;
  finishArtifactDelete(artifactId: string, userId: string): Promise<void>;
}

export interface TaskArtifactReader {
  readForOwner(artifactId: string, userId: string): Promise<{ metadata: TaskArtifactMetadata; body: Buffer }>;
}

export interface TaskArtifactWriter extends TaskArtifactReader {
  isReady(): Promise<boolean>;
  storeJson(input: {
    userId: string;
    taskId: string;
    kind: TaskArtifactKind;
    filename: string;
    body: Buffer;
  }): Promise<TaskArtifactMetadata>;
  deleteForOwner(artifactId: string, userId: string): Promise<boolean>;
}

/** External binary/object storage boundary. Implementations must validate key, size, and digest. */
export interface ObjectStorage {
  isReady(): Promise<boolean>;
  put(input: { key: string; body: Readable; contentType: string; byteLength: number; sha256: string }): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
}
