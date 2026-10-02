import type { TaskStatus } from './types.js';

const ALLOWED: Record<TaskStatus, readonly TaskStatus[]> = {
  QUEUED: ['PLANNING', 'FAILED', 'CANCELLED'],
  PLANNING: ['RUNNING', 'FAILED', 'CANCELLED'],
  RUNNING: ['WAITING', 'VERIFYING', 'FAILED', 'CANCELLED'],
  WAITING: ['RUNNING', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid task state transition: ${from} -> ${to}`);
}
