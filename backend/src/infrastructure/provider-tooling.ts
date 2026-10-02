import { randomUUID } from 'node:crypto';
import type { AiGatewayRequest, AiToolCall } from '../domain/ai-gateway.js';

type JsonRecord = Record<string, unknown>;
const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;

export function validateProviderToolRequest(request: AiGatewayRequest): void {
  const tools = request.tools ?? [];
  if (tools.length === 0) {
    if (request.toolChoice) throw new Error('A tool choice requires at least one registered tool.');
    return;
  }
  if (tools.length > 8) throw new Error('Provider tool declaration limit exceeded.');
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(tool.name) || names.has(tool.name) ||
        !tool.description.trim() || tool.description.length > 1_000 || asRecord(tool.parameters) === null) {
      throw new Error('Invalid provider tool declaration.');
    }
    names.add(tool.name);
    if (JSON.stringify(tool.parameters).length > 16_384) throw new Error('Provider tool schema exceeded its size limit.');
  }
  if (request.toolChoice && request.toolChoice !== 'auto' && request.toolChoice !== 'required') {
    throw new Error('Invalid provider tool-choice mode.');
  }
}

export function normalizeProviderToolCall(id: unknown, name: unknown, input: unknown): AiToolCall {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(name)) throw new Error('Provider returned an invalid tool name.');
  if (!asRecord(input)) throw new Error('Provider returned invalid tool arguments.');
  const safeId = typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id)
    ? id
    : randomUUID();
  return { id: safeId, name, input };
}

export function parseOpenAiToolCalls(value: unknown): AiToolCall[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw new Error('Provider returned an invalid number of tool calls.');
  return value.map((rawCall) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call?.function);
    if (typeof fn?.arguments !== 'string') throw new Error('Provider returned invalid tool arguments.');
    return normalizeProviderToolCall(call?.id, fn.name, JSON.parse(fn.arguments));
  });
}

export function parseObjectJson(content: string): JsonRecord {
  const value: unknown = JSON.parse(content);
  const record = asRecord(value);
  if (!record) throw new Error('Tool result was not a JSON object.');
  return record;
}
