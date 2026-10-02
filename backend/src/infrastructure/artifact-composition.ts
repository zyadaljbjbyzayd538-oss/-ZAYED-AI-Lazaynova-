import type { Pool } from 'pg';
import type { TaskArtifactWriter } from '../application/artifact-ports.js';
import { PostgresTaskArtifactRepository } from './postgres-task-artifacts.js';
import { createS3ObjectStorageFromEnvironment } from './s3-object-storage.js';
import { TaskArtifactService } from './task-artifact-service.js';

/** Artifacts are unavailable unless every required server-side S3 setting is supplied. */
export function buildTaskArtifactServiceFromEnvironment(
  env: NodeJS.ProcessEnv,
  pool: Pool,
): (TaskArtifactWriter & { close(): void }) | undefined {
  const storage = createS3ObjectStorageFromEnvironment(env);
  if (!storage) return undefined;
  const service = new TaskArtifactService(new PostgresTaskArtifactRepository(pool), storage);
  return Object.assign(service, { close: () => storage.close() });
}
