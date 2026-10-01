import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../domain/errors.js';
import type { AiGateway, AiGatewayRequest, AiGatewayResponse, AiGatewayStreamEvent, AiToolCall } from '../domain/ai-gateway.js';
import type { EvidenceItem } from '../domain/types.js';
import { MAX_GENERATION_RESPONSE_BYTES, MAX_MODEL_INVENTORY_RESPONSE_BYTES, providerEndpoint, readBoundedJson, readServerSentEvents, validateProviderBaseUrl } from './provider-http.js';
import type { GatewayProfileConfig } from './gateway-profile.js';
import { normalizeProviderToolCall, parseObjectJson, validateProviderToolRequest } from './provider-tooling.js';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface NativeProviderGatewayConfig extends Omit<GatewayProfileConfig, 'protocol' | 'apiKey'> {
  protocol: 'anthropic' | 'gemini';
  apiKey: string;
}

abstract class NativeProviderGateway implements AiGateway {
  protected readonly baseUrl: URL;
  protected readonly timeoutMs: number;
  protected readonly provider: string;
  private readonly readinessCacheMs: number;
  private readinessCache: { ready: boolean; expiresAt: number } | null = null;

  protected constructor(
    protected readonly config: NativeProviderGatewayConfig,
    provider: string,
    private readonly fetchImpl: typeof fetch,
  ) {
    if (!config.apiKey.trim()) throw new Error(`${provider} profile requires a server-side API key.`);
    if (!config.model.trim() || config.model.length > 200 || /[\u0000-\u001f\u007f]/.test(config.model)) {
      throw new Error(`${provider} profile has an invalid model identifier.`);
    }
    const timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('AI provider timeout must be an integer between 1000 and 120000 milliseconds.');
    }
    const readinessCacheMs = config.readinessCacheMs ?? 5_000;
    if (!Number.isInteger(readinessCacheMs) || readinessCacheMs < 0 || readinessCacheMs > 60_000) {
      throw new Error('AI provider readiness cache must be between 0 and 60000 milliseconds.');
    }
    this.baseUrl = validateProviderBaseUrl(config.baseUrl, config.allowInsecureHttp === true);
    this.timeoutMs = timeoutMs;
    this.readinessCacheMs = readinessCacheMs;
    this.provider = provider;
  }

  async isReady(): Promise<boolean> {
    if (this.readinessCache && this.readinessCache.expiresAt > Date.now()) return this.readinessCache.ready;
    let ready = false;
    try { ready = (await this.listModels()).includes(this.config.model); } catch { ready = false; }
    this.readinessCache = { ready, expiresAt: Date.now() + this.readinessCacheMs };
    return ready;
  }

  async listModels(): Promise<string[]> {
    try {
      const { body } = await this.requestJson(this.modelsPath(), { method: 'GET' }, 2_000, MAX_MODEL_INVENTORY_RESPONSE_BYTES);
      const allModels = [...new Set(this.parseModelIds(body)
        .filter((model) => typeof model === 'string' && model.length > 0 && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model)))];
      if (!allModels.includes(this.config.model)) {
        try {
          const { body: detail } = await this.requestJson(this.configuredModelPath(), { method: 'GET' }, 1_000, MAX_MODEL_INVENTORY_RESPONSE_BYTES);
          if (this.configuredModelMatches(detail)) allModels.push(this.config.model);
        } catch {
          // Keep the list result; a missing or unreachable detail endpoint means the selected model is not confirmed.
        }
      }
      allModels.sort();
      const models = allModels.slice(0, 100);
      if (allModels.includes(this.config.model) && !models.includes(this.config.model)) models[99] = this.config.model;
      return models.sort();
    } catch {
      throw new HttpError(503, 'AI_MODEL_CATALOG_UNAVAILABLE', 'The configured model provider inventory is unavailable.');
    }
  }

  abstract generate(request: AiGatewayRequest): Promise<AiGatewayResponse>;

  protected abstract modelsPath(): string;
  protected abstract configuredModelPath(): string;
  protected configuredModelMatches(body: unknown): boolean { return this.parseModelIds(body).includes(this.config.model); }
  protected abstract parseModelIds(body: unknown): string[];
  protected abstract authHeaders(): Record<string, string>;

  protected async requestJson(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    maxBytes: number,
    callerSignal?: AbortSignal,
  ): Promise<{ body: unknown; response: Response }> {
    const headers = new Headers({ accept: 'application/json', ...this.authHeaders() });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(providerEndpoint(this.baseUrl, path), {
      ...init,
      headers,
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Provider returned a non-success status.');
    return { body: await readBoundedJson(response, maxBytes), response };
  }

  protected async requestStream(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const headers = new Headers({ accept: 'text/event-stream', ...this.authHeaders() });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await this.fetchImpl(providerEndpoint(this.baseUrl, path), {
      ...init,
      headers,
      redirect: 'error',
      signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      throw new Error('Provider did not return a successful event stream.');
    }
    return response;
  }

  protected outputTokenLimit(request: AiGatewayRequest, defaultValue = 4_096): number {
    const value = request.maxOutputTokens ?? defaultValue;
    if (!Number.isInteger(value) || value < 1 || value > 128_000) throw new Error('Invalid provider output-token limit.');
    return value;
  }

  protected safeModel(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : fallback;
  }

  protected safeRequestId(value: unknown): string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)
      ? value
      : randomUUID();
  }

  protected safeUsage(input: unknown, output: unknown): { inputTokens: number; outputTokens: number } | undefined {
    return Number.isSafeInteger(input) && typeof input === 'number' && input >= 0
      && Number.isSafeInteger(output) && typeof output === 'number' && output >= 0
      ? { inputTokens: input, outputTokens: output }
      : undefined;
  }

  protected completeResponse(
    request: AiGatewayRequest,
    text: string,
    model: string,
    requestId: string,
    usage?: { inputTokens: number; outputTokens: number },
    toolCalls?: AiToolCall[],
    providerContext?: unknown,
  ): AiGatewayResponse {
    const serializedInput = JSON.stringify({ systemPrompt: request.systemPrompt, messages: request.messages, model, tools: request.tools ?? [], toolChoice: request.toolChoice });
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
      ...(providerContext !== undefined ? { providerContext } : {}),
      provider: this.provider,
      model,
      requestId,
      ...(usage ? { usage } : {}),
      evidence,
    };
  }

  protected async generateSafely<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch {
      throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.');
    }
  }

  protected generationResponseLimit(): number { return MAX_GENERATION_RESPONSE_BYTES; }
}

export class AnthropicGateway extends NativeProviderGateway {
  constructor(config: NativeProviderGatewayConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    super(config, 'anthropic', fetchImpl);
  }

  protected modelsPath(): string { return 'models?limit=100'; }
  protected configuredModelPath(): string { return `models/${encodeURIComponent(this.config.model)}`; }
  protected configuredModelMatches(body: unknown): boolean { return asRecord(body)?.id === this.config.model; }

  protected parseModelIds(body: unknown): string[] {
    const data = asRecord(body)?.data;
    if (!Array.isArray(data)) throw new Error('Anthropic model inventory response was malformed.');
    return data.flatMap((item) => {
      const id = asRecord(item)?.id;
      return typeof id === 'string' ? [id] : [];
    });
  }

  protected authHeaders(): Record<string, string> {
    return { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' };
  }

  async generate(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    return this.generateSafely(async () => {
      validateProviderToolRequest(request);
      const model = this.config.model;
      const messages = request.messages.map((message): JsonRecord => {
        if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }] };
        if (message.role === 'assistant' && message.toolCalls?.length) {
          const providerContent = Array.isArray(message.providerContext) ? message.providerContext : [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
          ];
          return { role: 'assistant', content: providerContent };
        }
        return { role: message.role, content: message.content };
      });
      const body = {
        model,
        max_tokens: this.outputTokenLimit(request),
        system: request.systemPrompt,
        messages,
        ...(request.tools?.length ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })) } : {}),
        ...(request.toolChoice === 'required' ? { tool_choice: { type: 'any', disable_parallel_tool_use: true } }
          : request.toolChoice === 'auto' ? { tool_choice: { type: 'auto', disable_parallel_tool_use: true } } : {}),
      };
      const { body: raw, response } = await this.requestJson('messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, this.timeoutMs, this.generationResponseLimit(), request.signal);
      const result = asRecord(raw);
      const blocks = Array.isArray(result?.content) ? result.content : [];
      const toolCalls = blocks.flatMap((block) => {
        const item = asRecord(block);
        return item?.type === 'tool_use' ? [normalizeProviderToolCall(item.id, item.name, item.input)] : [];
      });
      if (toolCalls.length > 4 || toolCalls.some((call) => !request.tools?.some((tool) => tool.name === call.name))) {
        throw new Error('Anthropic returned an unregistered tool call.');
      }
      const text = blocks.flatMap((block) => {
        const item = asRecord(block);
        return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : [];
      }).join('\n').trim();
      if (!text && toolCalls.length === 0) throw new Error('Anthropic response did not contain text or a tool call.');
      const actualModel = this.safeModel(result?.model, model);
      const requestId = this.safeRequestId(response.headers.get('request-id') ?? result?.id);
      const usage = asRecord(result?.usage);
      return this.completeResponse(request, text, actualModel, requestId,
        this.safeUsage(usage?.input_tokens, usage?.output_tokens), toolCalls.length ? toolCalls : undefined,
        toolCalls.length ? blocks : undefined);
    });
  }

  async *stream(request: AiGatewayRequest): AsyncGenerator<AiGatewayStreamEvent> {
    try {
      validateProviderToolRequest(request);
      if (request.tools?.length) throw new Error('Streaming Chat does not support model-directed tools.');
      const messages = request.messages.map((message): JsonRecord => ({ role: message.role, content: message.content }));
      const body = {
        model: this.config.model,
        max_tokens: this.outputTokenLimit(request),
        system: request.systemPrompt,
        messages,
        stream: true,
      };
      const response = await this.requestStream('messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, request.signal);

      let text = '';
      let model = this.config.model;
      let requestId = this.safeRequestId(response.headers.get('request-id'));
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let stopped = false;
      for await (const event of readServerSentEvents(response, this.generationResponseLimit())) {
        const raw = asRecord(JSON.parse(event.data));
        if (!raw) throw new Error('Anthropic stream event was malformed.');
        if (event.event === 'error' || raw.type === 'error') throw new Error('Anthropic returned a streaming error.');
        if (raw.type === 'message_start') {
          const message = asRecord(raw.message);
          model = this.safeModel(message?.model, model);
          requestId = this.safeRequestId(response.headers.get('request-id') ?? message?.id);
          const usage = asRecord(message?.usage);
          if (typeof usage?.input_tokens === 'number' && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0) inputTokens = usage.input_tokens;
        } else if (raw.type === 'content_block_start') {
          const block = asRecord(raw.content_block);
          if (block?.type === 'tool_use') throw new Error('Anthropic attempted tool use in text-only streaming Chat.');
        } else if (raw.type === 'content_block_delta') {
          const delta = asRecord(raw.delta);
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            text += delta.text;
            if (Buffer.byteLength(text, 'utf8') > MAX_GENERATION_RESPONSE_BYTES) throw new Error('Generated content exceeded its size limit.');
            yield { type: 'text_delta', content: delta.text };
          } else if (delta?.type && delta.type !== 'text_delta') {
            throw new Error('Anthropic returned a non-text Chat segment.');
          }
        } else if (raw.type === 'message_delta') {
          const usage = asRecord(raw.usage);
          if (typeof usage?.output_tokens === 'number' && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens >= 0) outputTokens = usage.output_tokens;
        } else if (raw.type === 'message_stop') {
          stopped = true;
        }
      }
      if (!stopped || !text.trim()) throw new Error('Anthropic stream ended before a complete text response.');
      const usage = this.safeUsage(inputTokens, outputTokens);
      const complete = this.completeResponse(request, text, model, requestId, usage);
      yield { type: 'completed', provider: complete.provider, model: complete.model, requestId: complete.requestId, ...(complete.usage ? { usage: complete.usage } : {}), evidence: complete.evidence };
    } catch {
      throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.');
    }
  }
}

export class GeminiGateway extends NativeProviderGateway {
  constructor(config: NativeProviderGatewayConfig, fetchImpl: typeof fetch = globalThis.fetch) {
    super(config, 'google-gemini', fetchImpl);
  }

  protected modelsPath(): string { return 'models?pageSize=100'; }
  protected configuredModelPath(): string { return `models/${encodeURIComponent(this.config.model)}`; }
  protected configuredModelMatches(body: unknown): boolean {
    const model = asRecord(body);
    if (!model) return false;
    const methods = Array.isArray(model.supportedActions) ? model.supportedActions : model.supportedGenerationMethods;
    const id = typeof model.baseModelId === 'string'
      ? model.baseModelId
      : typeof model.name === 'string' && model.name.startsWith('models/')
        ? model.name.slice('models/'.length)
        : undefined;
    return id === this.config.model && Array.isArray(methods) && methods.includes('generateContent');
  }

  protected parseModelIds(body: unknown): string[] {
    const models = asRecord(body)?.models;
    if (!Array.isArray(models)) throw new Error('Gemini model inventory response was malformed.');
    return models.flatMap((entry) => {
      const model = asRecord(entry);
      if (!model) return [];
      const methods = Array.isArray(model.supportedActions) ? model.supportedActions : model.supportedGenerationMethods;
      if (!Array.isArray(methods) || !methods.includes('generateContent')) return [];
      const baseModelId = model.baseModelId;
      if (typeof baseModelId === 'string' && baseModelId.length > 0) return [baseModelId];
      const name = model.name;
      return typeof name === 'string' && name.startsWith('models/') ? [name.slice('models/'.length)] : [];
    });
  }

  protected authHeaders(): Record<string, string> {
    return { 'x-goog-api-key': this.config.apiKey };
  }

  async generate(request: AiGatewayRequest): Promise<AiGatewayResponse> {
    return this.generateSafely(async () => {
      validateProviderToolRequest(request);
      const model = this.config.model;
      const contents = request.messages.map((message): JsonRecord => {
        if (message.role === 'tool') return {
          role: 'user',
          parts: [{ functionResponse: {
            name: message.name,
            response: parseObjectJson(message.content),
            id: message.toolCallId,
          } }],
        };
        if (message.role === 'assistant' && message.toolCalls?.length) {
          const providerContent = asRecord(message.providerContext);
          if (providerContent?.role === 'model' && Array.isArray(providerContent.parts)) return providerContent;
          return {
            role: 'model',
            parts: [
              ...(message.content ? [{ text: message.content }] : []),
              ...message.toolCalls.map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.input } })),
            ],
          };
        }
        return {
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        };
      });
      const tools = request.tools?.length ? [{
        functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      }] : undefined;
      const body = {
        systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents,
        ...(tools ? { tools } : {}),
        ...(request.toolChoice ? { toolConfig: { functionCallingConfig: {
          mode: request.toolChoice === 'required' ? 'ANY' : 'AUTO',
          ...(request.toolChoice === 'required' && request.tools ? { allowedFunctionNames: request.tools.map((tool) => tool.name) } : {}),
        } } } : {}),
        ...(request.maxOutputTokens !== undefined ? { generationConfig: { maxOutputTokens: this.outputTokenLimit(request) } } : {}),
      };
      const path = `models/${encodeURIComponent(model)}:generateContent`;
      const { body: raw, response } = await this.requestJson(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, this.timeoutMs, this.generationResponseLimit(), request.signal);
      const result = asRecord(raw);
      const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
      const candidate = asRecord(candidates[0]);
      const content = asRecord(candidate?.content);
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      const toolCalls = parts.flatMap((part) => {
        const item = asRecord(part);
        const call = asRecord(item?.functionCall);
        return call ? [normalizeProviderToolCall(call.id, call.name, call.args)] : [];
      });
      let providerContext: unknown;
      if (content && toolCalls.length > 0) {
        let callIndex = 0;
        providerContext = {
          ...content,
          parts: parts.map((part) => {
            const item = asRecord(part);
            const call = asRecord(item?.functionCall);
            if (!call) return part;
            const normalized = toolCalls[callIndex++];
            return normalized ? { ...item, functionCall: { ...call, id: normalized.id } } : part;
          }),
        };
      }
      if (toolCalls.length > 4 || toolCalls.some((call) => !request.tools?.some((tool) => tool.name === call.name))) {
        throw new Error('Gemini returned an unregistered function call.');
      }
      const text = parts.flatMap((part) => {
        const item = asRecord(part);
        return typeof item?.text === 'string' ? [item.text] : [];
      }).join('\n').trim();
      if (!text && toolCalls.length === 0) throw new Error('Gemini response did not contain text or a function call.');
      const modelVersion = this.safeModel(result?.modelVersion, model);
      const requestId = this.safeRequestId(response.headers.get('x-goog-request-id') ?? result?.responseId);
      const usage = asRecord(result?.usageMetadata);
      return this.completeResponse(request, text, modelVersion, requestId,
        this.safeUsage(usage?.promptTokenCount, usage?.candidatesTokenCount), toolCalls.length ? toolCalls : undefined,
        providerContext);
    });
  }

  async *stream(request: AiGatewayRequest): AsyncGenerator<AiGatewayStreamEvent> {
    try {
      validateProviderToolRequest(request);
      if (request.tools?.length) throw new Error('Streaming Chat does not support model-directed tools.');
      const model = this.config.model;
      const contents = request.messages.map((message): JsonRecord => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
      const body = {
        systemInstruction: { parts: [{ text: request.systemPrompt }] },
        contents,
        ...(request.maxOutputTokens !== undefined ? { generationConfig: { maxOutputTokens: this.outputTokenLimit(request) } } : {}),
      };
      const path = `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const response = await this.requestStream(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, request.signal);

      let text = '';
      let modelVersion = model;
      let requestId = this.safeRequestId(response.headers.get('x-goog-request-id'));
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let receivedTerminalFinishReason = false;
      for await (const event of readServerSentEvents(response, this.generationResponseLimit())) {
        if (event.data === '[DONE]') break;
        const raw = asRecord(JSON.parse(event.data));
        if (!raw) throw new Error('Gemini stream event was malformed.');
        if (raw.error) throw new Error('Gemini returned a streaming error.');
        modelVersion = this.safeModel(raw.modelVersion, modelVersion);
        requestId = this.safeRequestId(response.headers.get('x-goog-request-id') ?? raw.responseId ?? requestId);
        const usage = asRecord(raw.usageMetadata);
        if (usage) {
          if (Number.isSafeInteger(usage.promptTokenCount) && typeof usage.promptTokenCount === 'number' && usage.promptTokenCount >= 0) inputTokens = usage.promptTokenCount;
          if (Number.isSafeInteger(usage.candidatesTokenCount) && typeof usage.candidatesTokenCount === 'number' && usage.candidatesTokenCount >= 0) outputTokens = usage.candidatesTokenCount;
        }
        const candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
        for (const candidateValue of candidates) {
          const candidate = asRecord(candidateValue);
          if (typeof candidate?.finishReason === 'string') {
            if (candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
              throw new Error('Gemini stream ended with a non-success finish reason.');
            }
            receivedTerminalFinishReason = true;
          }
          const content = asRecord(candidate?.content);
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (const partValue of parts) {
            const part = asRecord(partValue);
            if (part?.functionCall) throw new Error('Gemini attempted tool use in text-only streaming Chat.');
            if (typeof part?.text === 'string' && part.text.length > 0) {
              text += part.text;
              if (Buffer.byteLength(text, 'utf8') > MAX_GENERATION_RESPONSE_BYTES) throw new Error('Generated content exceeded its size limit.');
              yield { type: 'text_delta', content: part.text };
            }
          }
        }
      }
      if (!text.trim() || !receivedTerminalFinishReason) throw new Error('Gemini stream ended without a complete text response.');
      const complete = this.completeResponse(request, text, modelVersion, requestId, this.safeUsage(inputTokens, outputTokens));
      yield { type: 'completed', provider: complete.provider, model: complete.model, requestId: complete.requestId, ...(complete.usage ? { usage: complete.usage } : {}), evidence: complete.evidence };
    } catch {
      throw new HttpError(503, 'AI_GATEWAY_REQUEST_FAILED', 'The configured AI gateway could not complete this request.');
    }
  }
}
