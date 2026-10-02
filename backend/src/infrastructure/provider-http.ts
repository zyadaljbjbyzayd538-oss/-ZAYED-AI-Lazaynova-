export const MAX_MODEL_INVENTORY_RESPONSE_BYTES = 1_048_576;
export const MAX_GENERATION_RESPONSE_BYTES = 4_194_304;

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Provider response exceeded its size limit.');
  if (!response.body) throw new Error('Provider response had no body.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('Provider response exceeded its size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
}

export interface ServerSentEvent {
  event: string;
  data: string;
}

/** Reads bounded UTF-8 server-sent events from a provider response without buffering the stream. */
export async function* readServerSentEvents(response: Response, maxBytes: number): AsyncGenerator<ServerSentEvent> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('Provider stream exceeded its size limit.');
  if (!response.body) throw new Error('Provider stream had no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let eventName = 'message';
  const dataLines: string[] = [];
  let totalBytes = 0;
  let streamEnded = false;

  const consumeLine = (rawLine: string): ServerSentEvent | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (dataLines.length === 0) {
        eventName = 'message';
        return null;
      }
      const result = { event: eventName, data: dataLines.join('\n') };
      eventName = 'message';
      dataLines.length = 0;
      return result;
    }
    if (line.startsWith(':')) return null;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      if (value.length > 128) throw new Error('Provider stream event name exceeded its limit.');
      eventName = value || 'message';
    } else if (field === 'data') {
      dataLines.push(value);
    }
    return null;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        streamEnded = true;
        buffer += decoder.decode();
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error('Provider stream exceeded its size limit.');
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const parsed = consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (parsed) yield parsed;
        newline = buffer.indexOf('\n');
      }
    }

    if (buffer.length > 0) {
      const parsed = consumeLine(buffer);
      if (parsed) yield parsed;
    }
    const finalEvent = consumeLine('');
    if (finalEvent) yield finalEvent;
  } finally {
    if (!streamEnded) {
      try { await reader.cancel(); } catch { /* The provider stream may already be closed. */ }
    }
    reader.releaseLock();
  }
}

export function providerEndpoint(baseUrl: URL, path: string): URL {
  const base = baseUrl.toString().endsWith('/') ? baseUrl : new URL(`${baseUrl.toString()}/`);
  return new URL(path, base);
}

export function validateProviderBaseUrl(baseUrl: string, allowInsecureHttp = false): URL {
  const parsed = new URL(baseUrl);
  const loopbackHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (loopbackHost || allowInsecureHttp))) {
    throw new Error('AI provider URLs must use HTTPS; HTTP requires loopback or explicit private-network opt-in.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Credentials, query strings, and fragments must not be embedded in AI provider base URLs.');
  }
  return parsed;
}
