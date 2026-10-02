import { Queue } from 'bullmq';
import type { Pool } from 'pg';

export const TASK_QUEUE_NAME = 'lazaynova-tasks';
export interface TaskJob { taskId: string }

export class OutboxDispatcher {
  private stopping = false;
  constructor(private readonly pool: Pool, private readonly queue: Queue<TaskJob>) {}

  stop(): void { this.stopping = true; }

  async dispatchBatch(limit = 20): Promise<number> {
    const client = await this.pool.connect();
    let rows: Array<{ id: string; task_id: string }> = [];
    try {
      await client.query('BEGIN');
      const claimed = await client.query(
        `WITH candidates AS (
           SELECT id FROM task_outbox
           WHERE (status = 'PENDING' AND available_at <= now()) OR (status = 'PUBLISHING' AND locked_until < now())
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE task_outbox o SET status = 'PUBLISHING', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
         FROM candidates c WHERE o.id = c.id RETURNING o.id, o.task_id`,
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
        // Stable job id makes a retry after a crash safe against duplicate execution.
        await this.queue.add('execute-task', { taskId: row.task_id }, { jobId: row.id, attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 1_000, removeOnFail: 5_000 });
        await this.pool.query(
          `UPDATE task_outbox SET status = 'PUBLISHED', published_at = now(), locked_until = NULL, last_error = NULL WHERE id = $1`,
          [row.id],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 2_000) : 'Queue publish failed';
        await this.pool.query(
          `UPDATE task_outbox SET status = 'PENDING', available_at = now() + LEAST(interval '5 minutes', interval '2 seconds' * power(2, LEAST(attempts, 7))), locked_until = NULL, last_error = $2 WHERE id = $1`,
          [row.id, message],
        );
      }
    }
    return rows.length;
  }

  async run(pollIntervalMs = 1_000): Promise<void> {
    while (!this.stopping) {
      try {
        const count = await this.dispatchBatch();
        if (count > 0) continue;
      } catch (error) {
        console.error('Outbox dispatch iteration failed:', error);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}
