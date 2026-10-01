import { createHash, randomUUID } from 'node:crypto';
import type { ResearchProvider, ResearchRequestReceipt, ResearchSearchResult } from '../application/research-ports.js';
import { HttpError } from '../domain/errors.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_SOURCES = 5;
const MAX_SOURCE_CHARS = 6_000;
const EXCERPT_CHARS = 2_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Research provider response body is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('Research provider response exceeded the size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function safeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.length === 0) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** Server-side Tavily Search adapter. It sends no requests to source URLs itself. */
export class TavilyResearchProvider implements ResearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 20_000,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    if (!apiKey.trim()) throw new Error('TAVILY_API_KEY is required.');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
      throw new Error('Tavily timeout must be an integer between 1000 and 120000 milliseconds.');
    }
  }

  async isReady(): Promise<boolean> {
    return this.apiKey.trim().length > 0;
  }

  async search(
    query: string,
    signal?: AbortSignal,
    onAcceptedRequest?: (receipt: ResearchRequestReceipt) => Promise<void>,
  ): Promise<ResearchSearchResult> {
    const normalizedQuery = query.trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!normalizedQuery) throw new HttpError(400, 'INVALID_RESEARCH_QUERY', 'A non-empty research query is required.');

    try {
      const response = await this.fetchImpl(TAVILY_SEARCH_URL, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: normalizedQuery,
          search_depth: 'advanced',
          max_results: MAX_SOURCES,
          include_answer: false,
          include_raw_content: true,
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new Error('Research provider returned a non-success status.');
      const headerRequestId = response.headers.get('x-request-id')?.trim();
      const requestId = headerRequestId && headerRequestId.length <= 200 && !/[\u0000-\u001f\u007f]/.test(headerRequestId)
        ? headerRequestId
        : randomUUID();
      if (onAcceptedRequest) {
        try { await onAcceptedRequest({ provider: 'tavily', requestId }); }
        catch { throw new HttpError(503, 'AI_USAGE_ACCOUNTING_FAILED', 'Provider usage could not be recorded safely.'); }
      }
      const body = asRecord(await readBoundedJson(response));
      const results = Array.isArray(body?.results) ? body.results : [];
      const sources: ResearchSearchResult['sources'] = [];
      const seen = new Set<string>();

      for (const item of results) {
        const record = asRecord(item);
        const url = safeSourceUrl(record?.url);
        const rawContent = typeof record?.raw_content === 'string' ? record.raw_content.replace(/\0/g, '').trim() : '';
        const title = typeof record?.title === 'string' ? record.title.replace(/\0/g, '').trim().slice(0, 500) : '';
        if (!url || !title || !rawContent || seen.has(url)) continue;
        seen.add(url);
        const content = rawContent.slice(0, MAX_SOURCE_CHARS);
        sources.push({ title, url, excerpt: content.slice(0, EXCERPT_CHARS), content });
        if (sources.length >= MAX_SOURCES) break;
      }
      if (sources.length === 0) {
        throw new HttpError(502, 'RESEARCH_NO_VERIFIABLE_SOURCES', 'The configured search provider returned no verifiable source content.');
      }

      const rawMaterial = sources.map((source) => `${source.url}\n${source.content}`).join('\n\n');
      return {
        provider: 'tavily',
        requestId,
        fetchedAt: new Date().toISOString(),
        rawSourceSha256: createHash('sha256').update(rawMaterial).digest('hex'),
        sources,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'RESEARCH_PROVIDER_REQUEST_FAILED', 'The configured research provider could not complete this request.');
    }
  }
}
