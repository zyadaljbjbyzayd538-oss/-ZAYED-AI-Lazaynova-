import { Pool } from 'pg';
import { HttpError } from '../domain/errors.js';
import type {
  WorkflowDefinitionInput,
  WorkflowDefinitionSummary,
  WorkflowDefinitionVersion,
  WorkflowVersionInput,
} from '../domain/workflow-definition.js';
import type { WorkflowDefinitionRepository } from '../application/workflow-definition-ports.js';
import { withTransaction } from './postgres.js';

export class PostgresWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  constructor(private readonly pool: Pool) {}

  async createWorkflowDefinition(ownerId: string, definition: WorkflowDefinitionInput): Promise<WorkflowDefinitionVersion> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const created = await client.query(
          `INSERT INTO workflow_definitions (owner_user_id, name, latest_version)
           VALUES ($1, $2, 1)
           RETURNING id, name, latest_version, created_at, updated_at`,
          [ownerId, definition.name],
        );
        const workflow = created.rows[0];
        const versionCreatedAt = await this.insertVersion(client, workflow.id, 1, definition.steps, ownerId);
        await this.writeVersionAudit(client, ownerId, workflow.id, 1, definition.steps.length);
        return this.toVersion(workflow, 1, definition.steps, versionCreatedAt);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, 'WORKFLOW_NAME_EXISTS', 'A workflow with this name already exists.');
      throw error;
    }
  }

  async createWorkflowDefinitionVersion(ownerId: string, workflowId: string, definition: WorkflowVersionInput): Promise<WorkflowDefinitionVersion | null> {
    return withTransaction(this.pool, async (client) => {
      const updated = await client.query(
        `UPDATE workflow_definitions
         SET latest_version = latest_version + 1, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2
         RETURNING id, name, latest_version, created_at, updated_at`,
        [workflowId, ownerId],
      );
      if (updated.rowCount !== 1) return null;
      const workflow = updated.rows[0];
      const version = Number(workflow.latest_version);
      const versionCreatedAt = await this.insertVersion(client, workflow.id, version, definition.steps, ownerId);
      await this.writeVersionAudit(client, ownerId, workflow.id, version, definition.steps.length);
      return this.toVersion(workflow, version, definition.steps, versionCreatedAt);
    });
  }

  async listWorkflowDefinitions(ownerId: string): Promise<WorkflowDefinitionSummary[]> {
    const result = await this.pool.query(
      `SELECT id, name, latest_version, created_at, updated_at
       FROM workflow_definitions WHERE owner_user_id = $1
       ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    return result.rows.map((row) => ({
      workflowId: row.id,
      name: row.name,
      latestVersion: Number(row.latest_version),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }

  async findWorkflowDefinitionVersion(ownerId: string, workflowId: string, version: number): Promise<WorkflowDefinitionVersion | null> {
    const result = await this.pool.query(
      `SELECT d.id, d.name, v.version, v.definition, v.created_at
       FROM workflow_definitions d
       JOIN workflow_definition_versions v ON v.workflow_id = d.id
       WHERE d.owner_user_id = $1 AND d.id = $2 AND v.version = $3`,
      [ownerId, workflowId, version],
    );
    const row = result.rows[0];
    return row ? this.toVersion(row, Number(row.version), row.definition.steps, row.created_at) : null;
  }

  async findLatestWorkflowDefinition(ownerId: string, workflowId: string): Promise<WorkflowDefinitionVersion | null> {
    const result = await this.pool.query(
      `SELECT d.id, d.name, v.version, v.definition, v.created_at
       FROM workflow_definitions d
       JOIN workflow_definition_versions v ON v.workflow_id = d.id AND v.version = d.latest_version
       WHERE d.owner_user_id = $1 AND d.id = $2`,
      [ownerId, workflowId],
    );
    const row = result.rows[0];
    return row ? this.toVersion(row, Number(row.version), row.definition.steps, row.created_at) : null;
  }

  private async insertVersion(client: import('pg').PoolClient, workflowId: string, version: number, steps: WorkflowDefinitionInput['steps'], ownerId: string): Promise<Date | string> {
    const result = await client.query(
      `INSERT INTO workflow_definition_versions (workflow_id, version, definition, created_by)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING created_at`,
      [workflowId, version, JSON.stringify({ steps }), ownerId],
    );
    return result.rows[0].created_at as Date | string;
  }

  private async writeVersionAudit(client: import('pg').PoolClient, ownerId: string, workflowId: string, version: number, stepCount: number): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
       VALUES ($1, 'WORKFLOW_DEFINITION_VERSION_CREATED', 'workflow_definition', $2, $3::jsonb)`,
      [ownerId, workflowId, JSON.stringify({ version, stepCount })],
    );
  }

  private toVersion(workflow: Record<string, any>, version: number, steps: WorkflowDefinitionInput['steps'], createdAt: Date | string): WorkflowDefinitionVersion {
    return {
      workflowId: workflow.id,
      name: workflow.name,
      version,
      steps,
      createdAt: new Date(createdAt).toISOString(),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
