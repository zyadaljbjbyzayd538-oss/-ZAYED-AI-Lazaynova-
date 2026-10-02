import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 120_000;

function requireLocalModelConfig(env: NodeJS.ProcessEnv): { baseUrl: string; model: string; apiKey?: string } {
  const baseUrl = env.AI_GATEWAY_LOCAL_BASE_URL?.trim();
  const model = env.AI_GATEWAY_LOCAL_MODEL?.trim();
  if (!baseUrl || !model) throw new Error('Local inference smoke test requires AI_GATEWAY_LOCAL_BASE_URL and AI_GATEWAY_LOCAL_MODEL.');

  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('The local model endpoint is invalid.'); }
  const allowInsecureHttp = env.AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === 'true';
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && allowInsecureHttp)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('The local model endpoint must use HTTPS, or explicitly allow internal HTTP, and contain no credentials/query/fragment.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(model)) throw new Error('The configured local model identifier is invalid.');

  const apiKey = env.AI_GATEWAY_LOCAL_API_KEY?.trim();
  return { baseUrl: endpoint.toString().replace(/\/$/, ''), model, ...(apiKey ? { apiKey } : {}) };
}

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw new Error('The local model response exceeded the diagnostic size limit.');
  if (!response.body) throw new Error('The local model response was empty.');

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) throw new Error('The local model response exceeded the diagnostic size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Sends a fixed, non-sensitive prompt to the explicitly configured local model and never logs its answer. */
export async function probeLocalInference(
  env: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = globalThis.fetch,
): Promise<{ model: string; responseBytes: number }> {
  const config = requireLocalModelConfig(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Local inference smoke test timed out.')), TIMEOUT_MS);
  try {
    const response = await request(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
        temperature: 0,
        max_tokens: 16,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`The local model returned HTTP ${response.status}.`);

    const body = await readBoundedBody(response);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { throw new Error('The local model returned invalid JSON.'); }
    const choices = parsed && typeof parsed === 'object' ? (parsed as { choices?: unknown }).choices : undefined;
    const first = Array.isArray(choices) ? choices[0] : undefined;
    const message = first && typeof first === 'object' ? (first as { message?: unknown }).message : undefined;
    const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The local model returned no completion text.');

    return { model: config.model, responseBytes: Buffer.byteLength(body) };
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await probeLocalInference();
    console.log(`[PASS] local inference: model ${result.model} returned a non-empty completion (${result.responseBytes} response bytes); generated text was not logged.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown local inference error';
    console.error(`[FAIL] local inference: ${message}`);
    process.exitCode = 1;
  }
}
