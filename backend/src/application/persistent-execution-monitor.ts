import type { TaskRepository } from './ports.js';
import type { ExecutionMonitor } from './orchestration-ports.js';
import type { GraphNodeStatus } from '../domain/task-graph.js';
import type { TaskStatus } from '../domain/types.js';

/** Persists concise, content-free task and graph events for polling and incident review. */
export class PersistentExecutionMonitor implements ExecutionMonitor {
  constructor(private readonly tasks: Pick<TaskRepository, 'appendTaskLog'>) {}

  async onTaskState(taskId: string, status: TaskStatus, detail?: string): Promise<void> {
    const suffix = detail ? `:${detail.replace(/[^A-Z0-9_.:-]/gi, '_').slice(0, 100)}` : '';
    await this.tasks.appendTaskLog(taskId, 'INFO', `TASK_STATE:${status}${suffix}`);
  }

  async onGraphNodeState(taskId: string, nodeId: string, status: GraphNodeStatus, attempt?: number): Promise<void> {
    const safeId = nodeId.replace(/[^a-z0-9_-]/gi, '_').slice(0, 48);
    const retry = attempt === undefined ? '' : `:attempt=${attempt}`;
    const level = status === 'FAILED' ? 'WARN' : 'INFO';
    await this.tasks.appendTaskLog(taskId, level, `GRAPH_NODE:${safeId}:${status}${retry}`);
  }
}
