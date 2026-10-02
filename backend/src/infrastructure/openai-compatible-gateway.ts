import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../domain/errors.js';
import type { AiGateway, AiGatewayRequest, AiGatewayResponse, AiGatewayStreamEvent } from '../domain/ai-gateway.js';
import type { EvidenceItem } from '../domain/types.js';

import { MAX_GENERATION_RESPONSE_BYTES, MAX_MODEL_INVENTORY_RESPONSE_BYTES, readBoundedJson, readServerSentEvents } from './provider-http.js';
import type { GatewayProfileConfig } from './gateway-profile.js';
import { parseOpenAiToolCalls, validateProviderToolRequest } from './provider-tooling.js';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface OpenAiCompatibleGatewayConfig extends Omit<GatewayProfileConfig, 'protocol'> {
  protocol?: 'openai-compatible';
}

/**
 * A real, server-side OpenAI-compatible adapter. Compatible local/private gateways can be used
 * without tying domain/Android code to a particular provider. Secrets are never logged or returned.
 */
export class OpenAiCompatibleGateway implements AiGateway {
  private readonly baseUrl: URL;
  private readonly provider: string;
  private readonly timeoutMs: number;
  private readonly readinessCacheMs: number;
  private readinessCache: { ready: boolean; expiresAt: number } | null = null;

  constructor(
    private readonly config: OpenAiCompatibleGatewayConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = new URL(config.baseUrl);
    const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== 'https:' && !(this.baseUrl.protocol === 'http:' && (loopbackHost || config.allowInsecureHttp === true))) {
      throw new Error('AI gateway URLs must use HTTPS; HTTP requires loopback or explicit private-network opt-in.');
    }
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error('Credentials, query strings, and fragments must not be embedded in AI_GATEWAY_BASE_URL.');
    }
    if (!Number.isInteger(config.timeoutMs ?? 30_000) || (config.timeoutMs ?? 30_000) < 1_000 || (config.timeoutMs ?? 30_000) > 120_000) {
      throw new Error('AI gateway timeout must be an integer between 1000 and 120000 milliseconds.');
    }
    this.provider = this.baseUrl.host;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.readinessCacheMs = config.readinessCacheMs ?? 5_000;
  }

  async isReady(): Promise<boolean> {
    if (this.readinessCache && this.readinessCache.expiresAt > Date.now()) return this.readinessCache.ready;
    let ready = false;
    try { ready = (await this.fetchModelIds(1_500)).includes(this.config.model); } catch { ready = false; }
    this.readinessCache = { ready, expiresAt: Date.now() + this.readinessCacheMs };
    return ready;
  }

  /** Queries the real provider inventory; callers receive safe model IDs, never credentials or URLs. */
  async listModels(): Promise<string[]> {
    return this.fetchModelIds(2_000);
  }

  private async fetchModelIds(timeoutMs: number): Promise<string[]> {
    try {
      const response = await this.fetchImpl(this.endpoint('models'), {
        method: 'GET',
        headers: this.headers(),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error('Model inventory request failed.');
      const body = asRecord(await readBoundedJson(response, MAX_MODEL_INVENTORY_RESPONSE_BYTES));
      if (!Array.isArray(body?.data)) throw new Error('Model inventory response was malformed.');
      const allModels = [...new Set(body.data.flatMap((entry) => {
        const model = asRecord(entry)?.id;
        return typeof model === 'string' && model.length > 0 && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model) ? [model] : [];
      }))].sort();
      const limitedModels = allModels.slice(0, 100);
      if (allModels.includes(this.config.model) && !limitedModels.includes(this.config.model)) limitedModels[99] = this.config.model;
      return limitedModels.sort();
    } catch {
      throw new HttpError(503, 'AI_MODEL_CATALOG_UNAVAILABLE', 'The configured model provider inventory is unavailable.');
    }
  }

  async generate(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    try {
      validateProviderToolRequest(request);
      const serializedInput = JSON.stringify({
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        model: this.config.model,
        tools: request.tools ?? [],
        toolChoice: request.toolChoice,
      });
      const providerMessages = [
        { role: 'system', content: request.systemPrompt },
        ...request.messages.map((message) => {
          if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
          if (message.role === 'assistant' && message.toolCalls) return {
            role: 'assistant',
            content: message.content || null,
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          };
          return { role: message.role, content: message.content };
        }),
      ];
      const response = await this.fetchImpl(this.endpoint('chat/completions'), {
        method: 'POST',
        redirect: 'error',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          messages: providerMessages,
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          ...(request.tools?.length ? { tools: request.tools.map((tool) => ({
            type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: true },
          })) } : {}),
          ...(request.toolChoice === 'required' ? { tool_choice: 'required' } : {}),
        }),
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error('Gateway returned a non-success status.');

      const body = asRecord(await readBoundedJson(response, MAX_GENERATION_RESPONSE_BYTES));
      const choice = Array.isArray(body?.choices) ? asRecord(body.choices[0]) : null;
      const message = asRecord(choice?.message);
      const toolCalls = parseOpenAiToolCalls(message?.tool_calls);
      if (toolCalls?.some((call) => !request.tools?.some((tool) => tool.name === call.name))) {
        throw new Error('The provider returned a tool call that was not declared for this request.');
      }
      const text = typeof message?.content === 'string' ? message.content : '';
      if (!text.trim() && !toolCalls?.length) throw new Error('Gateway response did not contain text or a tool call.');

      const model = typeof body?.model === 'string' && body.model.length > 0 ? body.model : this.config.model;
      const requestId = response.headers.get('x-request-id') ?? (typeof body?.id === 'string' ? body.id : randomUUID());
      const usage = asRecord(body?.usage);
      const evidence: EvidenceItem[] = [{
        kind: 'model_execution',
        provider: this.provider,
        model,
        modelVersion: model,
        requestId,
        inputSha256: sha256(serializedInput),
        outputSha256: sha256(JSON.stringify({ text, toolCalls })),
      }];

      return {
        text,
        ...(toolCalls ? { toolCalls } : {}),
        provider: this.provider,
        model,
        requestId,
        ...(typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number'
          ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
          : {}),
        evidence,
      };
    } catch {
      throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.');
    }
  }

  async *stream(request: AiGatewayRequest): AsyncGenerator<AiGatewayStreamEvent> {
    try {
      validateProviderToolRequest(request);
      if (request.tools?.length) throw new Error('Streaming Chat does not support model-directed tools.');
      const serializedInput = JSON.stringify({ systemPrompt: request.systemPrompt, messages: request.messages, model: this.config.model, tools: [] });
      const providerMessages = [
        { role: 'system', content: request.systemPrompt },
        ...request.messages.map((message) => ({ role: message.role, content: message.content })),
      ];
      const response = await this.fetchImpl(this.endpoint('chat/completions'), {
        method: 'POST',
        redirect: 'error',
        headers: { ...this.headers(), 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: this.config.model,
          messages: providerMessages,
          ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
          stream: true,
        }),
        signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        throw new Error('Gateway did not provide a successful event stream.');
      }

      let text = '';
      const safeString = (value: unknown, fallback: string): string =>
        typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
          ? value
          : fallback;
      let model = this.config.model;
      let requestId = safeString(response.headers.get('x-request-id'), randomUUID());
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      let receivedDone = false;
      for await (const event of readServerSentEvents(response, MAX_GENERATION_RESPONSE_BYTES)) {
        if (event.data === '[DONE]') {
          receivedDone = true;
          break;
        }
        const body = asRecord(JSON.parse(event.data));
        if (body?.error) throw new Error('Gateway reported a streaming failure.');
        model = safeString(body?.model, model);
        requestId = safeString(body?.id, requestId);
        const rawUsage = asRecord(body?.usage);
        if (Number.isSafeInteger(rawUsage?.prompt_tokens) && typeof rawUsage?.prompt_tokens === 'number' && rawUsage.prompt_tokens >= 0 &&
            Number.isSafeInteger(rawUsage?.completion_tokens) && typeof rawUsage.completion_tokens === 'number' && rawUsage.completion_tokens >= 0) {
          usage = { inputTokens: rawUsage.prompt_tokens, outputTokens: rawUsage.completion_tokens };
        }
        const choices = Array.isArray(body?.choices) ? body.choices : [];
        const choice = asRecord(choices[0]);
        const delta = asRecord(choice?.delta);
        if (delta?.tool_calls) throw new Error('Gateway returned a tool call during text-only streaming Chat.');
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
          text += delta.content;
          if (Buffer.byteLength(text, 'utf8') > MAX_GENERATION_RESPONSE_BYTES) throw new Error('Generated content exceeded its size limit.');
          yield { type: 'text_delta', content: delta.content };
        }
      }
      if (!receivedDone || !text.trim()) throw new Error('Gateway stream ended without a complete text response.');
      const evidence: EvidenceItem[] = [{
        kind: 'model_execution',
        provider: this.provider,
        model,
        modelVersion: model,
        requestId,
        inputSha256: sha256(serializedInput),
        outputSha256: sha256(JSON.stringify({ text })),
      }];
      yield { type: 'completed', provider: this.provider, model, requestId, ...(usage ? { usage } : {}), evidence };
    } catch {
      throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.');
    }
  }

  private endpoint(path: string): URL {
    const base = this.baseUrl.toString().endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.toString()}/`);
    return new URL(path, base);
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
  }
}
