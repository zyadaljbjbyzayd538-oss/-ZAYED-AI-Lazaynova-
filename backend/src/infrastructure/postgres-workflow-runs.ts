import { Pool, type PoolClient } from 'pg';
import type { WorkflowRunRepository, ApprovalResult, WorkflowCancelResult, WorkflowLeaseResult } from '../application/workflow-run-ports.js';
import type { WorkflowApprovalDecision, WorkflowRunCreateRecord, WorkflowRunRecord, WorkflowRunStepRecord } from '../domain/workflow-run.js';
import type { AgentResult, EvidenceItem, TaskInput } from '../domain/types.js';
import { workflowStepSchema } from '../domain/workflow-definition.js';
import { withTransaction } from './postgres.js';

const LEASE_STATUSES = "('QUEUED', 'RUNNING')";

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly pool: Pool) {}

  async createWorkflowRun(input: WorkflowRunCreateRecord): Promise<WorkflowRunRecord> {
    return withTransaction(this.pool, async (client) => {
      const created = await client.query(
        `INSERT INTO workflow_runs (owner_user_id, workflow_id, definition_version, workflow_name, input)
         SELECT $1, d.id, v.version, d.name, $4::jsonb
         FROM workflow_definitions d
         JOIN workflow_definition_versions v ON v.workflow_id = d.id AND v.version = $3
         WHERE d.id = $2 AND d.owner_user_id = $1
         RETURNING id, owner_user_id, workflow_id, definition_version, workflow_name, status, input,
                   result, evidence, error_code, cancel_requested_at, created_at, started_at, completed_at`,
        [input.ownerId, input.workflowId, input.version, JSON.stringify(input.input)],
      );
      const row = created.rows[0];
      if (!row) throw new Error('Workflow definition ownership or version changed before run acceptance.');
      for (const [ordinal, step] of input.steps.entries()) {
        await client.query(
          `INSERT INTO workflow_run_steps (workflow_run_id, step_id, ordinal, definition, approval_required)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [row.id, step.id, ordinal, JSON.stringify(step), step.approvalRequired],
        );
      }
      await client.query('INSERT INTO workflow_run_outbox (workflow_run_id) VALUES ($1)', [row.id]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'WORKFLOW_RUN_ACCEPTED', 'workflow_run', $2, $3::jsonb)`,
        [input.ownerId, row.id, JSON.stringify({ workflowId: input.workflowId, version: input.version, stepCount: input.steps.length })],
      );
      return this.readRun(client, row, input.steps.map((step) => ({ ...step, status: 'PENDING', attempts: 0, result: null, errorCode: null, approvedBy: null, approvedAt: null })) as WorkflowRunStepRecord[]);
    });
  }

  async findWorkflowRun(runId: string, ownerId: string): Promise<WorkflowRunRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT id, owner_user_id, workflow_id, definition_version, workflow_name, status, input,
                result, evidence, error_code, cancel_requested_at, created_at, started_at, completed_at
         FROM workflow_runs WHERE id = $1 AND owner_user_id = $2`,
        [runId, ownerId],
      );
      return result.rows[0] ? this.readRun(client, result.rows[0]) : null;
    });
  }

  async findWorkflowRunForWorker(runId: string): Promise<WorkflowRunRecord | null> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `SELECT id, owner_user_id, workflow_id, definition_version, workflow_name, status, input,
                result, evidence, error_code, cancel_requested_at, created_at, started_at, completed_at
         FROM workflow_runs WHERE id = $1`,
        [runId],
      );
      return result.rows[0] ? this.readRun(client, result.rows[0]) : null;
    });
  }

  async claimWorkflowRun(runId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE workflow_runs
         SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now(),
             lease_owner = $2, lease_expires_at = now() + (GREATEST($3, 1000) * interval '1 millisecond')
         WHERE id = $1 AND status IN ${LEASE_STATUSES} AND cancel_requested_at IS NULL
           AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= now() OR lease_owner = $2)
         RETURNING owner_user_id`,
        [runId, leaseOwner, leaseMilliseconds],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_RUN_CLAIMED', 'workflow_run', $1, '{}'::jsonb)`,
        [runId],
      );
      return true;
    });
  }

  async renewWorkflowRunLease(runId: string, leaseOwner: string, leaseMilliseconds: number): Promise<WorkflowLeaseResult> {
    return withTransaction(this.pool, async (client) => {
      const renewed = await client.query(
        `UPDATE workflow_runs SET lease_expires_at = now() + (GREATEST($3, 1000) * interval '1 millisecond'), updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING' AND cancel_requested_at IS NULL RETURNING id`,
        [runId, leaseOwner, leaseMilliseconds],
      );
      if (renewed.rowCount === 1) return 'RENEWED';
      const current = await client.query('SELECT status, cancel_requested_at FROM workflow_runs WHERE id = $1', [runId]);
      if (current.rows[0]?.status === 'CANCELLED' || current.rows[0]?.cancel_requested_at) return 'CANCELLED';
      return 'LOST';
    });
  }

  async releaseWorkflowRunLease(runId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(
      'UPDATE workflow_runs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2',
      [runId, leaseOwner],
    );
  }

  async markWorkflowStepWaitingApproval(runId: string, stepId: string, leaseOwner: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE workflow_run_steps s SET status = 'WAITING_APPROVAL', updated_at = now()
         FROM workflow_runs r
         WHERE s.workflow_run_id = $1 AND s.step_id = $2 AND s.approval_required = true AND s.status = 'PENDING'
           AND r.id = s.workflow_run_id AND r.status = 'RUNNING' AND r.lease_owner = $3
         RETURNING r.owner_user_id`,
        [runId, stepId, leaseOwner],
      );
      if (changed.rowCount !== 1) return false;
      await client.query(
        `UPDATE workflow_runs SET status = 'WAITING_APPROVAL', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING'`,
        [runId, leaseOwner],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_APPROVAL_REQUIRED', 'workflow_run', $1, $2::jsonb)`,
        [runId, JSON.stringify({ stepId })],
      );
      return true;
    });
  }

  async startWorkflowStep(runId: string, stepId: string, leaseOwner: string): Promise<number | null> {
    const result = await this.pool.query(
      `UPDATE workflow_run_steps s SET status = 'RUNNING', attempts = attempts + 1,
             started_at = COALESCE(started_at, now()), updated_at = now(), error_code = NULL
       FROM workflow_runs r
       WHERE s.workflow_run_id = $1 AND s.step_id = $2 AND s.status IN ('PENDING', 'APPROVED', 'FAILED', 'RUNNING')
         AND s.attempts < 3 AND r.id = s.workflow_run_id AND r.status = 'RUNNING' AND r.lease_owner = $3
       RETURNING s.attempts`,
      [runId, stepId, leaseOwner],
    );
    return result.rows[0] ? Number(result.rows[0].attempts) : null;
  }

  async completeWorkflowStep(runId: string, stepId: string, leaseOwner: string, result: AgentResult): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE workflow_run_steps s SET status = 'COMPLETED', result = $4::jsonb, evidence = $5::jsonb,
               completed_at = now(), updated_at = now(), error_code = NULL
         FROM workflow_runs r
         WHERE s.workflow_run_id = $1 AND s.step_id = $2 AND s.status = 'RUNNING'
           AND r.id = s.workflow_run_id AND r.status = 'RUNNING' AND r.lease_owner = $3`,
        [runId, stepId, leaseOwner, JSON.stringify({ result: result.result, provenance: result.provenance ?? {} }), JSON.stringify(result.evidence)],
      );
      if (changed.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_STEP_COMPLETED', 'workflow_run', $1, $2::jsonb)`,
        [runId, JSON.stringify({ stepId, evidenceCount: result.evidence.length })],
      );
      return true;
    });
  }

  async failWorkflowStep(runId: string, stepId: string, leaseOwner: string, code: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const changed = await client.query(
        `UPDATE workflow_run_steps s SET status = 'FAILED', error_code = $4, updated_at = now()
         FROM workflow_runs r
         WHERE s.workflow_run_id = $1 AND s.step_id = $2 AND s.status = 'RUNNING'
           AND r.id = s.workflow_run_id AND r.status = 'RUNNING' AND r.lease_owner = $3`,
        [runId, stepId, leaseOwner, code],
      );
      if (changed.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_STEP_FAILED', 'workflow_run', $1, $2::jsonb)`,
        [runId, JSON.stringify({ stepId, code })],
      );
      return true;
    });
  }

  async blockPendingWorkflowSteps(runId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(
      `UPDATE workflow_run_steps SET status = 'BLOCKED', updated_at = now()
       WHERE workflow_run_id = $1 AND status IN ('PENDING', 'APPROVED')
         AND EXISTS (SELECT 1 FROM workflow_runs WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2)`,
      [runId, leaseOwner],
    );
  }

  async completeWorkflowRun(runId: string, leaseOwner: string, result: WorkflowRunRecord['result'], evidence: EvidenceItem[]): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const completed = await client.query(
        `UPDATE workflow_runs SET status = 'COMPLETED', result = $3::jsonb, evidence = $4::jsonb,
             completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING' AND cancel_requested_at IS NULL
         RETURNING owner_user_id`,
        [runId, leaseOwner, JSON.stringify(result), JSON.stringify(evidence)],
      );
      if (completed.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_RUN_COMPLETED', 'workflow_run', $1, $2::jsonb)`,
        [runId, JSON.stringify({ stepCount: result?.outputs.length ?? 0, evidenceCount: evidence.length })],
      );
      return true;
    });
  }

  async failWorkflowRun(runId: string, leaseOwner: string, code: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const failed = await client.query(
        `UPDATE workflow_runs SET status = 'FAILED', error_code = $3, completed_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1 AND lease_owner = $2 AND status = 'RUNNING' AND cancel_requested_at IS NULL
         RETURNING owner_user_id`,
        [runId, leaseOwner, code],
      );
      if (failed.rowCount !== 1) return false;
      await client.query(
        `UPDATE workflow_run_steps SET status = 'BLOCKED', updated_at = now()
         WHERE workflow_run_id = $1 AND status IN ('PENDING', 'APPROVED')`, [runId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES (NULL, 'WORKFLOW_RUN_FAILED', 'workflow_run', $1, $2::jsonb)`,
        [runId, JSON.stringify({ code })],
      );
      return true;
    });
  }

  async decideWorkflowApproval(ownerId: string, runId: string, stepId: string, decision: WorkflowApprovalDecision): Promise<ApprovalResult> {
    return withTransaction(this.pool, async (client) => {
      const run = await client.query(
        `SELECT id, status FROM workflow_runs WHERE id = $1 AND owner_user_id = $2 FOR UPDATE`, [runId, ownerId],
      );
      if (!run.rows[0]) return 'NOT_FOUND';
      if (run.rows[0].status !== 'WAITING_APPROVAL') return 'NOT_WAITING';
      const step = await client.query(
        `UPDATE workflow_run_steps SET status = $4, approved_by = $3, approved_at = now(), updated_at = now(),
             error_code = CASE WHEN $4 = 'REJECTED' THEN 'WORKFLOW_APPROVAL_REJECTED' ELSE NULL END
         WHERE workflow_run_id = $1 AND step_id = $2 AND status = 'WAITING_APPROVAL' AND approval_required = true
         RETURNING step_id`,
        [runId, stepId, ownerId, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED'],
      );
      if (step.rowCount !== 1) return 'NOT_WAITING';
      if (decision === 'APPROVE') {
        await client.query(`UPDATE workflow_runs SET status = 'QUEUED', updated_at = now() WHERE id = $1`, [runId]);
        await client.query('INSERT INTO workflow_run_outbox (workflow_run_id) VALUES ($1)', [runId]);
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'WORKFLOW_STEP_APPROVED', 'workflow_run', $2, $3::jsonb)`,
          [ownerId, runId, JSON.stringify({ stepId })],
        );
        return 'APPROVED';
      }
      await client.query(
        `UPDATE workflow_runs SET status = 'FAILED', error_code = 'WORKFLOW_APPROVAL_REJECTED',
             completed_at = now(), updated_at = now() WHERE id = $1`, [runId],
      );
      await client.query(
        `UPDATE workflow_run_steps SET status = 'BLOCKED', updated_at = now()
         WHERE workflow_run_id = $1 AND status IN ('PENDING', 'APPROVED')`, [runId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'WORKFLOW_STEP_REJECTED', 'workflow_run', $2, $3::jsonb)`,
        [ownerId, runId, JSON.stringify({ stepId })],
      );
      return 'REJECTED';
    });
  }

  async cancelWorkflowRun(ownerId: string, runId: string): Promise<WorkflowCancelResult> {
    return withTransaction(this.pool, async (client) => {
      const cancelled = await client.query(
        `UPDATE workflow_runs SET status = 'CANCELLED', cancel_requested_at = now(), completed_at = now(), updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE id = $1 AND owner_user_id = $2 AND status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL')
         RETURNING id`, [runId, ownerId],
      );
      if (cancelled.rowCount === 1) {
        await client.query(
          `UPDATE workflow_run_steps SET status = 'BLOCKED', updated_at = now()
           WHERE workflow_run_id = $1 AND status IN ('PENDING', 'APPROVED', 'WAITING_APPROVAL')`, [runId],
        );
        await client.query(
          `INSERT INTO audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'WORKFLOW_RUN_CANCELLED', 'workflow_run', $2, '{}'::jsonb)`, [ownerId, runId],
        );
        return 'CANCELLED';
      }
      const existing = await client.query('SELECT status FROM workflow_runs WHERE id = $1 AND owner_user_id = $2', [runId, ownerId]);
      if (!existing.rows[0]) return 'NOT_FOUND';
      return existing.rows[0].status === 'CANCELLED' ? 'ALREADY_CANCELLED' : 'NOT_CANCELLABLE';
    });
  }

  private async readRun(client: PoolClient, row: Record<string, unknown>, stepsOverride?: WorkflowRunStepRecord[]): Promise<WorkflowRunRecord> {
    let steps = stepsOverride;
    if (!steps) {
      const result = await client.query(
        `SELECT definition, status, attempts, result, evidence, error_code, approved_by, approved_at
         FROM workflow_run_steps WHERE workflow_run_id = $1 ORDER BY ordinal`, [row.id],
      );
      steps = result.rows.map((step) => {
        const parsedDefinition = workflowStepSchema.safeParse(asRecord(step.definition));
        if (!parsedDefinition.success) throw new Error('Persisted workflow step definition is invalid.');
        const storedResult = asRecord(step.result);
        const storedEvidence = asEvidence(step.evidence);
        if (storedResult && (!Object.prototype.hasOwnProperty.call(storedResult, 'result') || !storedEvidence)) {
          throw new Error('Persisted workflow step result is malformed.');
        }
        const value: AgentResult | null = storedResult ? {
          result: storedResult.result,
          evidence: storedEvidence!,
          provenance: asRecord(storedResult.provenance) ?? {},
        } : null;
        return {
          ...parsedDefinition.data,
          status: step.status as WorkflowRunStepRecord['status'],
          attempts: Number(step.attempts),
          result: value,
          errorCode: typeof step.error_code === 'string' ? step.error_code : null,
          approvedBy: typeof step.approved_by === 'string' ? step.approved_by : null,
          approvedAt: iso(step.approved_at),
        };
      });
    }
    const rawInput = asRecord(row.input);
    if (!rawInput || typeof rawInput.text !== 'string' || rawInput.text.length < 1 || rawInput.text.length > 20_000 ||
        !Array.isArray(rawInput.attachments) || rawInput.attachments.length > 1 || rawInput.attachments.some((item) => typeof item !== 'string')) {
      throw new Error('Persisted workflow run input is malformed.');
    }
    return {
      runId: String(row.id),
      ownerId: String(row.owner_user_id),
      workflowId: String(row.workflow_id),
      workflowName: String(row.workflow_name),
      version: Number(row.definition_version),
      status: row.status as WorkflowRunRecord['status'],
      input: { text: rawInput.text, attachments: rawInput.attachments as string[] } satisfies TaskInput,
      steps,
      result: asRecord(row.result) as WorkflowRunRecord['result'],
      evidence: asEvidence(row.evidence),
      errorCode: typeof row.error_code === 'string' ? row.error_code : null,
      cancelRequested: row.cancel_requested_at !== null && row.cancel_requested_at !== undefined,
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value) as unknown); } catch { return null; }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function asEvidence(value: unknown): EvidenceItem[] | null {
  if (typeof value === 'string') {
    try { return asEvidence(JSON.parse(value) as unknown); } catch { return null; }
  }
  return Array.isArray(value) ? value as EvidenceItem[] : null;
}
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
