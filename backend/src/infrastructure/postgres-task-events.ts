import type { Pool, PoolClient } from 'pg';
import type { TaskEventSource, TaskStatusEvent } from '../application/task-events.js';
import type { TaskStatus } from '../domain/types.js';

const CHANNEL = 'lazaynova_task_events';
const TASK_STATUSES: readonly TaskStatus[] = [
  'QUEUED', 'PLANNING', 'RUNNING', 'WAITING', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED',
];

interface Subscription {
  userId: string;
  listener: (event: TaskStatusEvent) => void;
}

/** One PostgreSQL LISTEN connection per API process; payloads carry status only. */
export class PostgresTaskEventSource implements TaskEventSource {
  private readonly subscriptions = new Map<string, Set<Subscription>>();
  private client: PoolClient | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryDelayMs = 250;
  private closed = false;

  constructor(private readonly pool: Pool) {}

  get connected(): boolean {
    return this.client !== null;
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('Task event source has been closed');
    if (this.client) return;
    await this.connect();
  }

  subscribe(taskId: string, userId: string, listener: (event: TaskStatusEvent) => void): () => void {
    const subscription: Subscription = { userId, listener };
    const listeners = this.subscriptions.get(taskId) ?? new Set<Subscription>();
    listeners.add(subscription);
    this.subscriptions.set(taskId, listeners);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0) this.subscriptions.delete(taskId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    this.subscriptions.clear();
    if (client) {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      try { await client.query(`UNLISTEN ${CHANNEL}`); } catch { /* connection may already be gone */ }
      client.release();
    }
  }

  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    client.on('notification', (message) => {
      if (message.channel === CHANNEL && message.payload) this.dispatch(message.payload);
    });
    client.on('error', () => {
      if (this.client !== client) return;
      this.client = null;
      client.removeAllListeners('notification');
      client.release(true);
      this.scheduleReconnect();
    });
    try {
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.closed) {
        client.removeAllListeners('notification');
        client.removeAllListeners('error');
        client.release();
        return;
      }
      this.client = client;
      this.retryDelayMs = 250;
    } catch (error) {
      client.removeAllListeners('notification');
      client.removeAllListeners('error');
      client.release(true);
      this.scheduleReconnect();
      throw error;
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref();
  }

  private dispatch(payload: string): void {
    let value: unknown;
    try { value = JSON.parse(payload) as unknown; } catch { return; }
    if (!value || typeof value !== 'object') return;
    const event = value as Record<string, unknown>;
    if (
      typeof event.taskId !== 'string' || typeof event.userId !== 'string' ||
      typeof event.status !== 'string' || !TASK_STATUSES.includes(event.status as TaskStatus) ||
      typeof event.changedAt !== 'string' ||
      (event.errorCode !== undefined && typeof event.errorCode !== 'string')
    ) return;

    const listeners = this.subscriptions.get(event.taskId);
    if (!listeners) return;
    const statusEvent: TaskStatusEvent = {
      taskId: event.taskId,
      userId: event.userId,
      status: event.status as TaskStatus,
      changedAt: event.changedAt,
      ...(typeof event.errorCode === 'string' ? { errorCode: event.errorCode } : {}),
    };
    for (const subscription of listeners) {
      if (subscription.userId !== statusEvent.userId) continue;
      try { subscription.listener(statusEvent); } catch { /* a broken socket must not affect other subscribers */ }
    }
  }
}
