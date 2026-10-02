import type { EvidenceItem } from './types.js';

export interface AiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AiGatewayMessage =
  | { role: 'user' | 'assistant'; content: string; toolCalls?: AiToolCall[]; providerContext?: unknown }
  | { role: 'tool'; name: string; toolCallId: string; content: string };

export interface AiGatewayAccountingContext {
  userId: string;
  resourceType: 'CHAT' | 'TASK' | 'WORKFLOW_RUN';
  resourceId?: string;
}

export interface AiGatewayRequest {
  /** Set only by trusted server-side capability/planner code; never accept it from an API payload. */
  accountingContext?: AiGatewayAccountingContext;
  systemPrompt: string;
  messages: AiGatewayMessage[];
  maxOutputTokens?: number;
  tools?: AiToolDefinition[];
  toolChoice?: 'auto' | 'required';
  signal?: AbortSignal;
}

export interface AiGatewayResponse {
  text: string;
  toolCalls?: AiToolCall[];
  /** Opaque provider continuation data, kept server-side for a same-provider tool-call round trip. */
  providerContext?: unknown;
  provider: string;
  model: string;
  requestId: string;
  usage?: { inputTokens: number; outputTokens: number };
  evidence: EvidenceItem[];
}

/**
 * Provider-neutral text-generation boundary for server-side adapters. Provider selection,
 * credentials, protocol, and model IDs are operator configuration, never client/app constants.
 * Tool calls are suggestions only: application code must enforce a fixed allowlist and invoke
 * through the permission-checked Tool Manager. No default provider is configured, and callers
 * must not fabricate a response when the selected adapter is unavailable.
 */
export type AiGatewayStreamEvent =
  | { type: 'text_delta'; content: string }
  | {
      type: 'completed';
      provider: string;
      model: string;
      requestId: string;
      usage?: { inputTokens: number; outputTokens: number };
      evidence: EvidenceItem[];
    };

export interface AiGateway {
  isReady(): Promise<boolean>;
  generate(request: AiGatewayRequest): Promise<AiGatewayResponse>;
  /** Optional true provider token streaming. Implementations must not synthesize deltas. */
  stream?(request: AiGatewayRequest): AsyncIterable<AiGatewayStreamEvent>;
}
