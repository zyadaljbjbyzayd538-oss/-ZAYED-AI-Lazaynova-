import { AllowlistedToolManager, type AllowlistedTool } from '../application/tool-manager.js';
import type { AuditRepository, AuthRepository } from '../application/ports.js';
import type { AnalyzableFileContent, FileService } from '../application/file-ports.js';
import type { ResearchProvider, ResearchSearchResult } from '../application/research-ports.js';
import { TOOL_BUDGETS } from '../domain/types.js';
import { TavilyResearchProvider } from './tavily-research-provider.js';
import type { AiUsageRecorder } from '../application/ai-usage-ports.js';
import { loadTavilySearchPrice, type TavilySearchPrice } from './provider-usage-accounting.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseWebSearchInput(value: unknown): { query: string } {
  const input = asRecord(value);
  if (!input || typeof input.query !== 'string' || input.query.trim().length === 0 || input.query.length > 4_000) {
    throw new Error('Invalid search query.');
  }
  return { query: input.query.trim() };
}

function parseFileInput(value: unknown): { fileId: string } {
  const input = asRecord(value);
  if (!input || typeof input.fileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.fileId)) {
    throw new Error('Invalid file id.');
  }
  return { fileId: input.fileId };
}

export function buildCoreToolManager(
  auth: AuthRepository,
  audit: AuditRepository,
  files: FileService | undefined,
  research: ResearchProvider | undefined,
  usageRecorder?: AiUsageRecorder,
  tavilyPrice: TavilySearchPrice = loadTavilySearchPrice(undefined),
): AllowlistedToolManager {
  const tools: AllowlistedTool[] = [];
  if (research) {
    tools.push({
      name: 'web.search',
      description: 'Retrieve bounded web research sources through the configured search provider.',
      requiredCapability: 'WEB_RESEARCH',
      timeoutMilliseconds: 30_000,
      callsPerMinute: TOOL_BUDGETS['web.search'].callsPerMinute,
      callsPerDay: TOOL_BUDGETS['web.search'].callsPerDay,
      isReady: () => research.isReady(),
      parseInput: parseWebSearchInput,
      execute: async (context, input, signal) => {
        if (!usageRecorder) return research.search(input.query, signal);
        let recorded = false;
        const recordRequest = async (receipt: { provider: string; requestId: string }) => {
          if (recorded) return;
          await usageRecorder.recordProviderUsage({
            userId: context.userId,
            resourceType: context.resourceType === 'workflow_run' ? 'WORKFLOW_RUN' : 'TASK',
            ...(context.taskId ? { resourceId: context.taskId } : {}),
            provider: receipt.provider,
            model: 'advanced-search',
            requestId: receipt.requestId,
            usageKind: 'API_REQUEST',
            ...(receipt.provider.toLowerCase() === 'tavily' ? {
              ...(tavilyPrice.costMicrousd !== undefined ? { requestCostMicrousd: tavilyPrice.costMicrousd } : {}),
              pricingVersion: tavilyPrice.version,
            } : {}),
          });
          recorded = true;
        };
        const result = await research.search(input.query, signal, recordRequest);
        // Some injected/custom adapters cannot expose an accepted-response callback; record their completed call.
        if (!recorded) await recordRequest(result);
        return result;
      },
    } satisfies AllowlistedTool<{ query: string }, ResearchSearchResult>);
  }
  if (files) {
    tools.push({
      name: 'file.read_text',
      description: 'Read and parse one owner-scoped encrypted UTF-8 TXT/CSV file for analysis.',
      requiredCapability: 'FILE_ANALYSIS',
      timeoutMilliseconds: 10_000,
      callsPerMinute: TOOL_BUDGETS['file.read_text'].callsPerMinute,
      callsPerDay: TOOL_BUDGETS['file.read_text'].callsPerDay,
      isReady: () => files.isReady(),
      parseInput: parseFileInput,
      execute: async (context, input) => files.parseForAnalysis({ userId: context.userId, fileId: input.fileId }),
    } satisfies AllowlistedTool<{ fileId: string }, AnalyzableFileContent>);
  }
  if (tools.length === 0) {
    // Keep the manager real but unavailable when no adapters are configured.
    return new AllowlistedToolManager(auth, audit, []);
  }
  return new AllowlistedToolManager(auth, audit, tools);
}

export function buildCoreToolManagerFromEnvironment(
  env: NodeJS.ProcessEnv,
  auth: AuthRepository,
  audit: AuditRepository,
  files?: FileService,
  usageRecorder?: AiUsageRecorder,
): AllowlistedToolManager {
  const apiKey = env.TAVILY_API_KEY?.trim();
  if (!apiKey && env.AI_RESEARCH_PROVIDER?.trim()) throw new Error('AI_RESEARCH_PROVIDER requires TAVILY_API_KEY.');
  let research: ResearchProvider | undefined;
  if (apiKey) {
    const timeoutMilliseconds = env.TAVILY_TIMEOUT_MS?.trim() ? Number(env.TAVILY_TIMEOUT_MS) : 20_000;
    if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 120_000) {
      throw new Error('TAVILY_TIMEOUT_MS must be an integer between 1000 and 120000.');
    }
    research = new TavilyResearchProvider(apiKey, timeoutMilliseconds);
  }
  return buildCoreToolManager(auth, audit, files, research, usageRecorder, loadTavilySearchPrice(env.TAVILY_ESTIMATED_COST_MICRO_USD_PER_CALL));
}
