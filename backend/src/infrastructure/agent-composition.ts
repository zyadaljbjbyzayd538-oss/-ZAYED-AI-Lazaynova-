import { AgentRegistry } from '../domain/agent-registry.js';
import type { AiGateway } from '../domain/ai-gateway.js';
import { ChatAgentDriver, FileAnalysisAgentDriver, ModelAnalysisAgentDriver, WebResearchAgentDriver, WritingAgentDriver } from '../application/ai-drivers.js';
import { CapabilityPlanner } from '../application/capability-planner.js';
import { ModelTaskPlanner } from '../application/model-task-planner.js';
import type { Planner, ToolManager } from '../application/orchestration-ports.js';
import type { FileService } from '../application/file-ports.js';
import { AiModelCatalog, type ModelProfileSource } from '../application/ai-model-catalog.js';
import type { ResearchProvider } from '../application/research-ports.js';
import { OpenAiCompatibleGateway } from './openai-compatible-gateway.js';
import { AnthropicGateway, GeminiGateway, type NativeProviderGatewayConfig } from './native-provider-gateways.js';
import type { GatewayProfileConfig } from './gateway-profile.js';
import { TavilyResearchProvider } from './tavily-research-provider.js';
import type { AiUsageRecorder } from '../application/ai-usage-ports.js';
import { UsageReportingAiGateway } from './provider-usage-accounting.js';

const PROFILE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

type ConfiguredGateway = AiGateway & { listModels(): Promise<string[]> };
type GatewayFactory = (config: GatewayProfileConfig) => AiGateway;
type ResearchFactory = (apiKey: string, timeoutMs: number) => ResearchProvider;

function configuredProfiles(env: NodeJS.ProcessEnv): Map<string, GatewayProfileConfig> {
  const profiles = new Map<string, GatewayProfileConfig>();
  const names = (env.AI_GATEWAY_PROVIDERS ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
  const legacyConfigured = Boolean(env.AI_GATEWAY_BASE_URL?.trim() || env.AI_GATEWAY_MODEL?.trim() || env.AI_GATEWAY_API_KEY?.trim());
  if (names.length === 0 && legacyConfigured) names.push('default');
  if (new Set(names).size !== names.length) throw new Error('AI_GATEWAY_PROVIDERS contains duplicate profile names.');

  for (const name of names) {
    if (!PROFILE_NAME.test(name)) throw new Error(`Invalid AI gateway profile name: ${name}`);
    const prefix = name === 'default' ? 'AI_GATEWAY' : `AI_GATEWAY_${name.toUpperCase()}`;
    const rawProtocol = env[`${prefix}_PROTOCOL`]?.trim().toLowerCase() ?? 'openai-compatible';
    if (!['openai-compatible', 'anthropic', 'gemini'].includes(rawProtocol)) throw new Error(`${prefix}_PROTOCOL must be openai-compatible, anthropic, or gemini.`);
    const protocol = rawProtocol as GatewayProfileConfig['protocol'];
    const baseUrlText = env[`${prefix}_BASE_URL`]?.trim();
    const defaultBaseUrl = protocol === 'anthropic'
      ? 'https://api.anthropic.com/v1'
      : protocol === 'gemini'
        ? 'https://generativelanguage.googleapis.com/v1beta'
        : undefined;
    const baseUrl = baseUrlText || defaultBaseUrl;
    const model = env[`${prefix}_MODEL`]?.trim();
    const apiKey = env[`${prefix}_API_KEY`]?.trim();
    const insecureHttpText = env[`${prefix}_ALLOW_INSECURE_HTTP`]?.trim().toLowerCase();
    const timeoutText = env[`${prefix}_TIMEOUT_MS`]?.trim();
    if (!baseUrl || !model) throw new Error(`AI gateway profile "${name}" requires ${prefix}_MODEL and a valid ${prefix}_BASE_URL (OpenAI-compatible profiles require a base URL).`);
    if (protocol !== 'openai-compatible' && !apiKey) throw new Error(`${prefix}_API_KEY is required for the ${protocol} provider.`);
    if (insecureHttpText && insecureHttpText !== 'true' && insecureHttpText !== 'false') {
      throw new Error(`${prefix}_ALLOW_INSECURE_HTTP must be true or false.`);
    }
    const timeoutMs = timeoutText ? Number(timeoutText) : undefined;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000)) {
      throw new Error(`${prefix}_TIMEOUT_MS must be an integer between 1000 and 120000.`);
    }
    profiles.set(name, {
      protocol,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(insecureHttpText === 'true' ? { allowInsecureHttp: true } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }
  return profiles;
}

function selectedProfileName(
  env: NodeJS.ProcessEnv,
  variable: 'AI_CHAT_PROVIDER' | 'AI_WRITING_PROVIDER' | 'AI_MODEL_ANALYSIS_PROVIDER' | 'AI_RESEARCH_PROVIDER' | 'AI_FILE_ANALYSIS_PROVIDER' | 'AI_PLANNER_PROVIDER',
  profiles: Map<string, GatewayProfileConfig>,
  requireExplicit = false,
): string | undefined {
  const explicit = env[variable]?.trim().toLowerCase();
  if (explicit) {
    if (!profiles.has(explicit)) throw new Error(`${variable} selects an unconfigured AI gateway profile: ${explicit}`);
    return explicit;
  }
  if (requireExplicit) return undefined;
  if (profiles.has('default')) return 'default';
  return profiles.size === 1 ? profiles.keys().next().value : undefined;
}

/** Creates a provider adapter from server-only profile configuration; no client chooses this protocol or model. */
export function createConfiguredGateway(config: GatewayProfileConfig): ConfiguredGateway {
  if (config.protocol === 'anthropic') {
    if (!config.apiKey) throw new Error('Anthropic profile requires a server-side API key.');
    return new AnthropicGateway({ ...config, protocol: 'anthropic', apiKey: config.apiKey } as NativeProviderGatewayConfig);
  }
  if (config.protocol === 'gemini') {
    if (!config.apiKey) throw new Error('Gemini profile requires a server-side API key.');
    return new GeminiGateway({ ...config, protocol: 'gemini', apiKey: config.apiKey } as NativeProviderGatewayConfig);
  }
  if (config.protocol === 'openai-compatible') return new OpenAiCompatibleGateway({ ...config, protocol: 'openai-compatible' });
  throw new Error('Unsupported AI provider protocol.');
}

/** API and worker share the same configured providers; selection never silently fails over across privacy boundaries. */
export function buildAgentRegistryFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createGateway: GatewayFactory = createConfiguredGateway,
  createResearchProvider: ResearchFactory = (apiKey, timeoutMs) => new TavilyResearchProvider(apiKey, timeoutMs),
  fileService?: FileService,
  toolManager?: ToolManager,
  usageRecorder?: AiUsageRecorder,
): AgentRegistry {
  const registry = new AgentRegistry();
  const profiles = configuredProfiles(env);
  if (profiles.size === 0) {
    selectedProfileName(env, 'AI_CHAT_PROVIDER', profiles);
    selectedProfileName(env, 'AI_WRITING_PROVIDER', profiles);
    selectedProfileName(env, 'AI_MODEL_ANALYSIS_PROVIDER', profiles);
    selectedProfileName(env, 'AI_RESEARCH_PROVIDER', profiles);
    selectedProfileName(env, 'AI_FILE_ANALYSIS_PROVIDER', profiles);
    selectedProfileName(env, 'AI_PLANNER_PROVIDER', profiles, true);
    return registry;
  }

  const gateways = new Map<string, AiGateway>();
  for (const [name, config] of profiles) {
    const gateway = createGateway(config);
    gateways.set(name, usageRecorder ? new UsageReportingAiGateway(gateway, usageRecorder) : gateway);
  }
  const chatName = selectedProfileName(env, 'AI_CHAT_PROVIDER', profiles);
  const writingName = selectedProfileName(env, 'AI_WRITING_PROVIDER', profiles);
  const analysisName = selectedProfileName(env, 'AI_MODEL_ANALYSIS_PROVIDER', profiles);
  const fileAnalysisName = selectedProfileName(env, 'AI_FILE_ANALYSIS_PROVIDER', profiles, true);
  selectedProfileName(env, 'AI_PLANNER_PROVIDER', profiles, true);
  const chatGateway = chatName ? gateways.get(chatName) : undefined;
  const writingGateway = writingName ? gateways.get(writingName) : undefined;
  const analysisGateway = analysisName ? gateways.get(analysisName) : undefined;
  const fileAnalysisGateway = fileAnalysisName ? gateways.get(fileAnalysisName) : undefined;
  if (chatGateway) registry.register(new ChatAgentDriver(chatGateway));
  if (writingGateway) registry.register(new WritingAgentDriver(writingGateway));
  if (analysisGateway) registry.register(new ModelAnalysisAgentDriver(analysisGateway));
  if (fileAnalysisGateway && fileService) registry.register(new FileAnalysisAgentDriver(fileAnalysisGateway, fileService, toolManager));

  const tavilyApiKey = env.TAVILY_API_KEY?.trim();
  if (!tavilyApiKey && env.AI_RESEARCH_PROVIDER?.trim()) throw new Error('AI_RESEARCH_PROVIDER requires TAVILY_API_KEY.');
  if (tavilyApiKey) {
    const researchName = selectedProfileName(env, 'AI_RESEARCH_PROVIDER', profiles);
    const researchGateway = researchName ? gateways.get(researchName) : undefined;
    const timeoutMs = env.TAVILY_TIMEOUT_MS?.trim() ? Number(env.TAVILY_TIMEOUT_MS) : 20_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('TAVILY_TIMEOUT_MS must be an integer between 1000 and 120000.');
    }
    if (researchGateway) {
      const researchProvider = createResearchProvider(tavilyApiKey, timeoutMs);
      registry.register(new WebResearchAgentDriver(researchGateway, researchProvider, toolManager));
    }
  }
  return registry;
}

/** Uses the configured planner profile only when explicitly selected; otherwise the offline one-node planner is used. */
export function buildTaskPlannerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createGateway: GatewayFactory = createConfiguredGateway,
  usageRecorder?: AiUsageRecorder,
): Planner {
  const profiles = configuredProfiles(env);
  const plannerName = selectedProfileName(env, 'AI_PLANNER_PROVIDER', profiles, true);
  if (!plannerName) return new CapabilityPlanner();
  const config = profiles.get(plannerName);
  if (!config) throw new Error('AI_PLANNER_PROVIDER selects an unconfigured gateway profile.');
  const gateway = createGateway(config);
  return new ModelTaskPlanner(usageRecorder ? new UsageReportingAiGateway(gateway, usageRecorder) : gateway);
}

type ModelListGatewayFactory = (config: GatewayProfileConfig) => { listModels(): Promise<string[]> };

/** Builds a safe server-side inventory from the same profile/routing configuration as real drivers. */
export function buildAiModelCatalogFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  createGateway: ModelListGatewayFactory = createConfiguredGateway,
): AiModelCatalog {
  const profiles = configuredProfiles(env);
  const assignments: Array<{
    capability: string;
    variable: Parameters<typeof selectedProfileName>[1];
    requireExplicit: boolean;
  }> = [
    { capability: 'CHAT', variable: 'AI_CHAT_PROVIDER', requireExplicit: false },
    { capability: 'WRITING', variable: 'AI_WRITING_PROVIDER', requireExplicit: false },
    { capability: 'MODEL_ANALYSIS', variable: 'AI_MODEL_ANALYSIS_PROVIDER', requireExplicit: false },
    { capability: 'WEB_RESEARCH', variable: 'AI_RESEARCH_PROVIDER', requireExplicit: false },
    { capability: 'FILE_ANALYSIS', variable: 'AI_FILE_ANALYSIS_PROVIDER', requireExplicit: true },
    { capability: 'TASK_PLANNER', variable: 'AI_PLANNER_PROVIDER', requireExplicit: true },
  ];
  const assigned = new Map<string, string[]>();
  for (const assignment of assignments) {
    const profileName = selectedProfileName(env, assignment.variable, profiles, assignment.requireExplicit);
    if (!profileName) continue;
    const capabilities = assigned.get(profileName) ?? [];
    capabilities.push(assignment.capability);
    assigned.set(profileName, capabilities);
  }
  const sources: ModelProfileSource[] = [...profiles.entries()].map(([profileName, config]) => {
    const gateway = createGateway(config);
    return {
      profileName,
      configuredModel: config.model,
      assignedCapabilities: assigned.get(profileName) ?? [],
      listAvailableModels: () => gateway.listModels(),
    };
  });
  return new AiModelCatalog(sources);
}
