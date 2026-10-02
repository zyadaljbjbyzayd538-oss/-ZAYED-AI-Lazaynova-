import test from 'node:test';
import assert from 'node:assert/strict';
import { probeLocalInference } from '../src/scripts/local-inference-smoke.js';

const localEnv: NodeJS.ProcessEnv = {
  AI_GATEWAY_LOCAL_BASE_URL: 'http://ollama:11434/v1',
  AI_GATEWAY_LOCAL_MODEL: 'qwen2.5:7b',
  AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP: 'true',
};

test('local inference smoke probe sends a fixed bounded prompt and requires non-empty completion content', async () => {
  let receivedUrl = '';
  let requestBody: Record<string, unknown> | undefined;
  const result = await probeLocalInference(localEnv, async (input, init) => {
    receivedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Hello from a local model.' } }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.equal(receivedUrl, 'http://ollama:11434/v1/chat/completions');
  assert.equal(result.model, 'qwen2.5:7b');
  assert.ok(result.responseBytes > 0);
  assert.equal(requestBody?.model, 'qwen2.5:7b');
  assert.equal(requestBody?.stream, false);
  assert.equal(requestBody?.max_tokens, 16);
  assert.deepEqual(requestBody?.messages, [{ role: 'user', content: 'Reply with a short greeting.' }]);
});

test('local inference smoke probe rejects bad endpoints, empty outputs, oversized replies, and provider failures', async () => {
  await assert.rejects(() => probeLocalInference({ ...localEnv, AI_GATEWAY_LOCAL_BASE_URL: 'http://ollama:11434/v1', AI_GATEWAY_LOCAL_ALLOW_INSECURE_HTTP: 'false' }), /must use HTTPS/);
  await assert.rejects(() => probeLocalInference(localEnv, async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))), /no completion text/);
  await assert.rejects(() => probeLocalInference(localEnv, async () => new Response('x'.repeat(65 * 1024))), /size limit/);
  await assert.rejects(() => probeLocalInference(localEnv, async () => new Response('private upstream detail', { status: 503 })), /HTTP 503/);
});
