import { createHash } from 'node:crypto';
import { HttpError } from '../domain/errors.js';
import type { AiGateway, AiGatewayAccountingContext, AiGatewayRequest, AiGatewayResponse, AiGatewayStreamEvent } from '../domain/ai-gateway.js';
import type { AiUsageRecorder, ProviderUsageReport } from '../application/ai-usage-ports.js';

const MAX_RATE_MICRO_USD = 1_000_000_000_000;
const MILLION = 1_000_000n;

export interface ModelPriceRate {
  inputMicrousdPerMillionTokens: number;
  outputMicrousdPerMillionTokens: number;
}

export interface ModelPricingSchedule {
  readonly version: string;
  get(provider: string, model: string): ModelPriceRate | undefined;
}

export interface TavilySearchPrice {
  readonly version: string;
  readonly costMicrousd?: string;
}

/** Optional operator-configured per-call estimate. Tavily billing varies by plan and search mode. */
export function loadTavilySearchPrice(raw: string | undefined): TavilySearchPrice {
  const value = raw?.trim();
  if (value && (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 19 || BigInt(value) > 9_223_372_036_854_775_807n)) {
    throw new Error('TAVILY_ESTIMATED_COST_MICRO_USD_PER_CALL must be a non-negative integer in micro-USD.');
  }
  const config = { provider: 'tavily', operation: 'advanced-search', costMicrousd: value ?? null };
  return {
    version: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
    ...(value !== undefined ? { costMicrousd: value } : {}),
  };
}

/** JSON is server-owned config; keys are provider/model and rates are integer micro-USD per million tokens. */
export function loadModelPricingSchedule(raw: string | undefined): ModelPricingSchedule {
  let decoded: unknown = {};
  if (raw?.trim()) {
    try { decoded = JSON.parse(raw); } catch { throw new Error('AI_MODEL_PRICING_JSON must contain valid JSON.'); }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('AI_MODEL_PRICING_JSON must be a provider/model rate object.');
  }
  const rates = new Map<string, ModelPriceRate>();
  for (const [key, value] of Object.entries(decoded)) {
    const separator = key.indexOf('/');
    const provider = key.slice(0, separator);
    const model = key.slice(separator + 1);
    if (separator <= 0 || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider) || !model.trim() || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
      throw new Error('AI_MODEL_PRICING_JSON contains an invalid provider/model key.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`AI_MODEL_PRICING_JSON has an invalid rate for ${key}.`);
    const rate = value as Record<string, unknown>;
    const input = rate.inputMicrousdPerMillionTokens;
    const output = rate.outputMicrousdPerMillionTokens;
    if (!Number.isSafeInteger(input) || Number(input) < 0 || Number(input) > MAX_RATE_MICRO_USD ||
        !Number.isSafeInteger(output) || Number(output) < 0 || Number(output) > MAX_RATE_MICRO_USD ||
        Object.keys(rate).some((property) => !['inputMicrousdPerMillionTokens', 'outputMicrousdPerMillionTokens'].includes(property))) {
      throw new Error(`AI_MODEL_PRICING_JSON has an invalid rate for ${key}.`);
    }
    const normalizedKey = `${provider.toLowerCase()}/${model}`;
    if (rates.has(normalizedKey)) throw new Error('AI_MODEL_PRICING_JSON contains duplicate case-insensitive model keys.');
    rates.set(normalizedKey, { inputMicrousdPerMillionTokens: Number(input), outputMicrousdPerMillionTokens: Number(output) });
  }
  const canonical = [...rates.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const version = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return {
    version,
    get(provider, model) { return rates.get(`${provider.toLowerCase()}/${model}`); },
  };
}

export function estimateProviderCostMicrousd(
  usage: { inputTokens: number; outputTokens: number },
  rate: ModelPriceRate,
): string {
  if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
    throw new Error('Provider token usage is invalid.');
  }
  const input = BigInt(usage.inputTokens) * BigInt(rate.inputMicrousdPerMillionTokens);
  const output = BigInt(usage.outputTokens) * BigInt(rate.outputMicrousdPerMillionTokens);
  const total = (input + output) / MILLION;
  if (total > 9_223_372_036_854_775_807n) throw new Error('Estimated model cost exceeded the supported range.');
  return total.toString();
}

/** Decorates actual gateways to persist usage before returning completions to a caller. */
export class UsageReportingAiGateway implements AiGateway {
  constructor(private readonly gateway: AiGateway, private readonly usage: AiUsageRecorder) {}

  isReady(): Promise<boolean> { return this.gateway.isReady(); }

  async generate(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    const response = await this.gateway.generate(request);
    await this.record(request.accountingContext, response);
    return response;
  }

  async *stream(request: AiGatewayRequest): AsyncGenerator<AiGatewayStreamEvent> {
    if (!this.gateway.stream) throw new HttpError(501, 'AI_GATEWAY_STREAMING_UNAVAILABLE', 'The configured provider does not support streaming.');
    for await (const event of this.gateway.stream(request)) {
      if (event.type === 'completed') await this.record(request.accountingContext, event);
      yield event;
    }
  }

  private async record(context: AiGatewayAccountingContext | undefined, response: {
    provider: string;
    model: string;
    requestId: string;
    usage?: { inputTokens: number; outputTokens: number };
  }): Promise<void> {
    if (!context) return;
    const report: ProviderUsageReport = {
      ...context,
      provider: response.provider,
      model: response.model,
      ...(response.requestId.trim() ? { requestId: response.requestId } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
    };
    try {
      await this.usage.recordProviderUsage(report);
    } catch {
      throw new HttpError(503, 'AI_USAGE_ACCOUNTING_FAILED', 'Provider usage could not be recorded safely.');
    }
  }
}
