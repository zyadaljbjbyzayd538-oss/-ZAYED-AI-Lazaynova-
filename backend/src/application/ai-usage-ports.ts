import type { AiGatewayAccountingContext } from '../domain/ai-gateway.js';

export type AiUsageContext = AiGatewayAccountingContext;

export interface ProviderUsageReport extends AiUsageContext {
  provider: string;
  model: string;
  requestId?: string;
  /** Model calls report tokens; non-model APIs can report a successful request with no token usage. */
  usageKind?: 'MODEL_TOKENS' | 'API_REQUEST';
  usage?: { inputTokens: number; outputTokens: number };
  /** Trusted server-priced per-request estimate in integer micro-USD; omitted when its tariff is unknown. */
  requestCostMicrousd?: string;
  pricingVersion?: string;
}

export interface AiUsageSummary {
  currency: 'USD';
  requestCount: string;
  reportedUsageCount: string;
  unreportedUsageCount: string;
  nonTokenRequestCount: string;
  pricedRequestCount: string;
  unpricedRequestCount: string;
  inputTokens: string;
  outputTokens: string;
  costMicrousd: string;
  pricingVersions: string[];
}

/** Records token usage and operator-priced cost without storing prompts, completions, or provider secrets. */
export interface AiUsageRecorder {
  recordProviderUsage(report: ProviderUsageReport): Promise<void>;
}

export interface AiUsageReader {
  getUserUsageSummary(userId: string): Promise<AiUsageSummary>;
}
