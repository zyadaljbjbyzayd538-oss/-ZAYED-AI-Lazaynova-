export type AiProviderProtocol = 'openai-compatible' | 'anthropic' | 'gemini';

/** Server-only, environment-derived provider settings shared by model adapters. */
export interface GatewayProfileConfig {
  protocol: AiProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  readinessCacheMs?: number;
}
