import { Queue } from 'bullmq';
import type { Pool } from 'pg';

export const WORKFLOW_RUN_QUEUE_NAME = 'lazaynova-workflow-runs';
export interface WorkflowRunJob { workflowRunId: string }

/** Durable outbox dispatch with stable job IDs and recovery of abandoned publishing claims. */
export class WorkflowRunOutboxDispatcher {
  private stopping = false;
  constructor(private readonly pool: Pool, private readonly queue: Queue<WorkflowRunJob>) {}

  stop(): void { this.stopping = true; }

  async dispatchBatch(limit = 20): Promise<number> {
    const client = await this.pool.connect();
    let rows: Array<{ id: string; workflow_run_id: string }> = [];
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `WITH candidates AS (
           SELECT id FROM workflow_run_outbox
           WHERE (status = 'PENDING' AND available_at <= now()) OR (status = 'PUBLISHING' AND locked_until < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE workflow_run_outbox o SET status = 'PUBLISHING', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
         FROM candidates c WHERE o.id = c.id RETURNING o.id, o.workflow_run_id`,
        [limit],
      );
      rows = claimed.rows;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    for (const row of rows) {
      if (this.stopping) break;
      try {
        await this.queue.add('execute-workflow-run', { workflowRunId: row.workflow_run_id }, {
          jobId: row.id, attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1_000, removeOnFail: 5_000,
        });
        await this.pool.query(
          `UPDATE workflow_run_outbox SET status = 'PUBLISHED', published_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1`,
          [row.id],
        );
      } catch {
        await this.pool.query(
          `UPDATE workflow_run_outbox SET status = 'PENDING',
             available_at = now() + LEAST(interval '5 minutes', interval '2 seconds' * power(2, LEAST(attempts, 7))),
             locked_until = NULL, last_error = 'QUEUE_PUBLISH_FAILED' WHERE id = $1`,
          [row.id],
        );
      }
    }
    return rows.length;
  }

  async run(pollIntervalMs = 1_000): Promise<void> {
    while (!this.stopping) {
      try {
        if (await this.dispatchBatch() > 0) continue;
      } catch (error) {
        console.error('Workflow outbox dispatch iteration failed:', error instanceof Error ? error.name : 'UNKNOWN');
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
