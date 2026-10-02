import type { TaskStatus } from '../domain/types.js';

export interface TaskStatusEvent {
  taskId: string;
  userId: string;
  status: TaskStatus;
  changedAt: string;
  errorCode?: string;
}

/** Owner-filtered status-only stream. Task results remain available through the authenticated poll endpoint. */
export interface TaskEventSource {
  start(): Promise<void>;
  subscribe(taskId: string, userId: string, listener: (event: TaskStatusEvent) => void): () => void;
  close(): Promise<void>;
}
