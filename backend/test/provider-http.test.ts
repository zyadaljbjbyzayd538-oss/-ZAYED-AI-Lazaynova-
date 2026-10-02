import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerSentEvents } from '../src/infrastructure/provider-http.js';

function responseFromChunks(chunks: Uint8Array[], onCancel?: () => void, closeWhenDrained = true): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (closeWhenDrained) controller.close();
    },
    cancel() { onCancel?.(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE parser preserves named events, multiline data, CRLF, and UTF-8 across chunk boundaries', async () => {
  const bytes = new TextEncoder().encode('event: delta\r\ndata: Hello\r\ndata: 🌎\r\n\r\nevent: done\ndata: [DONE]');
  const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  const events = [];
  for await (const event of readServerSentEvents(responseFromChunks(chunks), 256)) events.push(event);
  assert.deepEqual(events, [
    { event: 'delta', data: 'Hello\n🌎' },
    { event: 'done', data: '[DONE]' },
  ]);
});

test('SSE parser enforces provider response byte limits and cancels oversized streams', async () => {
  let cancelled = false;
  const response = responseFromChunks([
    new TextEncoder().encode('data: 1234\n\n'),
    new TextEncoder().encode('data: 5678\n\n'),
  ], () => { cancelled = true; }, false);
  const events: string[] = [];
  await assert.rejects(async () => {
    for await (const event of readServerSentEvents(response, 15)) events.push(event.data);
  }, /exceeded its size limit/);
  assert.equal(cancelled, true);
  assert.deepEqual(events, ['1234']);
});

test('SSE parser cancels upstream when a consumer stops reading early', async () => {
  let cancelled = false;
  const response = responseFromChunks([
    new TextEncoder().encode('data: first\n\n'),
    new TextEncoder().encode('data: second\n\n'),
  ], () => { cancelled = true; }, false);
  for await (const event of readServerSentEvents(response, 256)) {
    assert.equal(event.data, 'first');
    break;
  }
  assert.equal(cancelled, true);
});

test('SSE parser rejects invalid UTF-8 rather than corrupting generated output', async () => {
  const response = responseFromChunks([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a])]);
  await assert.rejects(async () => {
    for await (const _event of readServerSentEvents(response, 32)) { /* consume */ }
  }, /encoded data was not valid for encoding utf-8|decode/);
});
