import type { AuthenticatedUser, Capability, TaskCapability, TaskInput, TaskRecord, TaskStatus, ToolName, ToolUsageDecision, UserIdentity, VerificationResult } from '../domain/types.js';
import type { FileRepository } from './file-ports.js';

export interface AuthRepository {
  findSessionByTokenHash(tokenHash: string, now: Date): Promise<AuthenticatedUser | null>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  createWebSocketTicket(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  consumeWebSocketTicket(tokenHash: string, now: Date): Promise<UserIdentity | null>;
  revokeSession(sessionId: string): Promise<void>;
  findUserByEmail(email: string): Promise<{ id: string; email: string; role: 'USER' | 'ADMIN'; passwordHash: string } | null>;
  findUserById(userId: string): Promise<{ id: string; email: string; role: 'USER' | 'ADMIN' } | null>;
  createUser(email: string, passwordHash: string, role: 'USER' | 'ADMIN'): Promise<string>;
  grantCapability(userId: string, capability: Capability, grantedBy: string): Promise<void>;
  revokeCapability(userId: string, capability: Capability, revokedBy: string): Promise<void>;
  hasCapability(userId: string, capability: Capability): Promise<boolean>;
  grantTool(userId: string, toolName: ToolName, grantedBy: string): Promise<void>;
  revokeTool(userId: string, toolName: ToolName, revokedBy: string): Promise<void>;
  hasToolGrant(userId: string, toolName: ToolName): Promise<boolean>;
  consumeToolUsage(userId: string, toolName: ToolName, callsPerMinute: number, callsPerDay: number): Promise<ToolUsageDecision>;
  listActiveToolGrants(userId: string): Promise<Array<{ toolName: ToolName; grantedAt: string; expiresAt: string | null }>>;
}

export interface TaskRepository {
  createTask(input: { userId: string; capability: TaskCapability; taskInput: TaskInput }): Promise<{ id: string; createdAt: string }>;
  findTask(taskId: string, userId: string): Promise<TaskRecord | null>;
  cancelTask(taskId: string, userId: string): Promise<'CANCELLED' | 'ALREADY_CANCELLED' | 'NOT_FOUND' | 'NOT_CANCELLABLE'>;
  findTaskForWorker(taskId: string): Promise<TaskRecord | null>;
  findTaskExecutionState(taskId: string): Promise<{ userId: string; status: TaskStatus } | null>;
  claimTaskExecution(taskId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean>;
  renewTaskExecutionLease(taskId: string, leaseOwner: string, leaseMilliseconds: number): Promise<boolean>;
  releaseTaskExecutionLease(taskId: string, leaseOwner: string): Promise<void>;
  transitionTask(taskId: string, from: TaskStatus, to: TaskStatus, details?: { error?: { code: string; message: string }; result?: unknown; verification?: VerificationResult; leaseOwner?: string }): Promise<boolean>;
  appendTaskLog(taskId: string, level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void>;
}

export interface AuditRepository {
  writeAudit(input: { actorUserId: string | null; action: string; resourceType: string; resourceId: string | null; details: Record<string, unknown> }): Promise<void>;
}
