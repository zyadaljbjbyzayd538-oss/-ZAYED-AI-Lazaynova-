import { Pool } from 'pg';
import type { AiUsageReader, AiUsageRecorder, AiUsageSummary, ProviderUsageReport } from '../application/ai-usage-ports.js';
import { estimateProviderCostMicrousd, type ModelPricingSchedule } from './provider-usage-accounting.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Content-free token/cost ledger. Provider IDs are used only for idempotency; prompts and completions are never stored. */
export class PostgresAiUsageLedger implements AiUsageRecorder, AiUsageReader {
  constructor(private readonly pool: Pool, private readonly pricing: ModelPricingSchedule) {}

  async recordProviderUsage(report: ProviderUsageReport): Promise<void> {
    if (!UUID_PATTERN.test(report.userId) || (report.resourceId !== undefined && !UUID_PATTERN.test(report.resourceId)) ||
        !['CHAT', 'TASK', 'WORKFLOW_RUN'].includes(report.resourceType) ||
        !PROVIDER_PATTERN.test(report.provider) || !report.model.trim() || report.model.length > 200 ||
        /[\u0000-\u001f\u007f]/.test(report.model)) {
      throw new Error('Provider usage attribution is invalid.');
    }
    if (report.requestId !== undefined && (!report.requestId.trim() || report.requestId.length > 200 || /[\u0000-\u001f\u007f]/.test(report.requestId))) {
      throw new Error('Provider request identifier is invalid.');
    }
    if (report.usage && (!Number.isSafeInteger(report.usage.inputTokens) || report.usage.inputTokens < 0 ||
        !Number.isSafeInteger(report.usage.outputTokens) || report.usage.outputTokens < 0)) {
      throw new Error('Provider token usage is invalid.');
    }

    const usageKind = report.usageKind ?? 'MODEL_TOKENS';
    if (!['MODEL_TOKENS', 'API_REQUEST'].includes(usageKind) ||
        (usageKind === 'API_REQUEST' && report.usage !== undefined) ||
        (usageKind === 'MODEL_TOKENS' && report.requestCostMicrousd !== undefined) ||
        (report.pricingVersion !== undefined && !/^[a-f0-9]{64}$/i.test(report.pricingVersion))) {
      throw new Error('Provider usage kind or pricing metadata is invalid.');
    }
    if (report.requestCostMicrousd !== undefined && (report.requestCostMicrousd.length > 19 ||
        !/^(0|[1-9][0-9]*)$/.test(report.requestCostMicrousd) || BigInt(report.requestCostMicrousd) > 9_223_372_036_854_775_807n)) {
      throw new Error('Provider request cost is invalid.');
    }

    const rate = this.pricing.get(report.provider, report.model);
    const costMicrousd = usageKind === 'API_REQUEST'
      ? report.requestCostMicrousd ?? null
      : report.usage && rate ? estimateProviderCostMicrousd(report.usage, rate) : null;
    const usageStatus = usageKind === 'API_REQUEST' ? 'REQUEST_ONLY' : report.usage ? 'REPORTED' : 'UNREPORTED';
    await this.pool.query(
      `INSERT INTO provider_usage_ledger (
         user_id, resource_type, resource_id, provider, model, provider_request_id,
         usage_status, input_tokens, output_tokens, cost_microusd, currency, pricing_version
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, 'USD', $11
       )
       ON CONFLICT (provider, provider_request_id) DO NOTHING`,
      [
        report.userId,
        report.resourceType,
        report.resourceId ?? null,
        report.provider,
        report.model,
        report.requestId ?? null,
        usageStatus,
        report.usage?.inputTokens ?? null,
        report.usage?.outputTokens ?? null,
        costMicrousd,
        report.pricingVersion ?? this.pricing.version,
      ],
    );
  }

  async getUserUsageSummary(userId: string): Promise<AiUsageSummary> {
    if (!UUID_PATTERN.test(userId)) throw new Error('Usage owner id is invalid.');
    const result = await this.pool.query(
      `SELECT count(*)::text AS request_count,
              count(*) FILTER (WHERE usage_status = 'REPORTED')::text AS reported_usage_count,
              count(*) FILTER (WHERE usage_status = 'UNREPORTED')::text AS unreported_usage_count,
              count(*) FILTER (WHERE usage_status = 'REQUEST_ONLY')::text AS non_token_request_count,
              count(*) FILTER (WHERE cost_microusd IS NOT NULL)::text AS priced_request_count,
              count(*) FILTER (WHERE cost_microusd IS NULL)::text AS unpriced_request_count,
              COALESCE(sum(input_tokens), 0)::text AS input_tokens,
              COALESCE(sum(output_tokens), 0)::text AS output_tokens,
              COALESCE(sum(cost_microusd), 0)::text AS cost_microusd,
              COALESCE(array_remove(array_agg(DISTINCT pricing_version), NULL), ARRAY[]::text[]) AS pricing_versions
       FROM provider_usage_ledger WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('Usage summary query returned no row.');
    return {
      currency: 'USD',
      requestCount: String(row.request_count),
      reportedUsageCount: String(row.reported_usage_count),
      unreportedUsageCount: String(row.unreported_usage_count),
      nonTokenRequestCount: String(row.non_token_request_count),
      pricedRequestCount: String(row.priced_request_count),
      unpricedRequestCount: String(row.unpriced_request_count),
      inputTokens: String(row.input_tokens),
      outputTokens: String(row.output_tokens),
      costMicrousd: String(row.cost_microusd),
      pricingVersions: Array.isArray(row.pricing_versions) ? row.pricing_versions.map(String) : [],
    };
  }
}
