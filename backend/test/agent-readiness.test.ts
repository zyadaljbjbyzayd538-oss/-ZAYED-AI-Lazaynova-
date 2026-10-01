import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, type CapabilityDriver } from '../src/domain/agent-registry.js';
import { CapabilityUnavailableError } from '../src/domain/errors.js';

test('missing driver reports not ready', async () => {
  const registry = new AgentRegistry();
  assert.deepEqual(await registry.readiness('CHAT'), { capability: 'CHAT', ready: false });
  await assert.rejects(() => registry.requireReady('CHAT'), CapabilityUnavailableError);
});

test('readiness probe failure fails closed as unavailable', async () => {
  const registry = new AgentRegistry();
  const driver: CapabilityDriver = {
    capability: 'CHAT',
    async isReady() { throw new Error('credential backend unavailable'); },
    async execute() { throw new Error('must not execute'); },
  };
  registry.register(driver);
  assert.deepEqual(await registry.readiness('CHAT'), { capability: 'CHAT', ready: false });
  await assert.rejects(() => registry.requireReady('CHAT'), CapabilityUnavailableError);
});
