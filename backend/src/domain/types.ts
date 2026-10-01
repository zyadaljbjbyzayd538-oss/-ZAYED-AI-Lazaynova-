export const CAPABILITIES = [
  'CHAT',
  'WRITING',
  'WEB_RESEARCH',
  'FILE_ANALYSIS',
  'CODING',
  'PROJECT',
  'MODEL_ANALYSIS',
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type TaskCapability = Exclude<Capability, 'CHAT'>;

/** Only these reviewed server-side tools may receive independent administrator grants. */
export const TOOL_CAPABILITIES = {
  'web.search': 'WEB_RESEARCH',
  'file.read_text': 'FILE_ANALYSIS',
} as const satisfies Record<string, TaskCapability>;
export type ToolName = keyof typeof TOOL_CAPABILITIES;

/** Durable per-user quotas; UTC day reset. These cap call volume, not monetary provider costs. */
export const TOOL_BUDGETS = {
  'web.search': { callsPerMinute: 20, callsPerDay: 200 },
  'file.read_text': { callsPerMinute: 30, callsPerDay: 500 },
} as const satisfies Record<ToolName, { callsPerMinute: number; callsPerDay: number }>;
export type ToolUsageDecision = 'ALLOWED' | 'MINUTE_LIMIT' | 'DAILY_LIMIT';

export interface TaskInput {
  text: string;
  attachments: string[];
  params?: Record<string, unknown>;
}
export type TaskStatus =
  | 'QUEUED'
  | 'PLANNING'
  | 'RUNNING'
  | 'WAITING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
export type UserRole = 'USER' | 'ADMIN';

export interface UserIdentity {
  id: string;
  email: string;
  role: UserRole;
}

export interface AuthenticatedUser extends UserIdentity {
  sessionId: string;
}

export interface TaskRecord {
  id: string;
  userId: string;
  type: TaskCapability;
  status: TaskStatus;
  priority: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  input: TaskInput;
  steps: Array<{ id: string; name: string; status: string; createdAt: string }>;
  logs: Array<{ id: string; level: string; message: string; createdAt: string }>;
  result: unknown | null;
  error: { code: string; message: string } | null;
  verification: VerificationResult | null;
  executionPlan?: {
    version: 1;
    rootCapability: TaskCapability;
    nodes: Array<{ id: string; capability: TaskCapability; operation: 'RUN_CAPABILITY'; goal: string; dependsOn: string[] }>;
  } | null;
  graphNodes?: Array<{ id: string; status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED'; attempts: number }>;
  evidenceChainRoot?: string | null;
}

export interface EvidenceItem {
  kind: string;
  [key: string]: unknown;
}

export interface VerificationResult {
  passed: boolean;
  checkedAt: string;
  evidence: EvidenceItem[];
  issues: string[];
}

export interface AgentResult {
  result: unknown;
  evidence: EvidenceItem[];
  provenance?: Record<string, unknown>;
}

export interface ChatConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentExecutionContext {
  taskId: string | null;
  userId: string;
  capability: Capability;
  input: TaskInput;
  conversation?: ChatConversationMessage[];
  signal?: AbortSignal;
  resourceType?: 'task' | 'workflow_run';
}
