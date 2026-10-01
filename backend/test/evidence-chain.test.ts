import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceChain, verifyEvidenceChain } from '../src/domain/evidence-chain.js';

test('evidence chain includes ordered hashes, a root marker, and verifies deterministically', () => {
  const source = [
    { kind: 'model_execution', provider: 'local', model: 'small-model', requestId: 'req-1' },
    { kind: 'source', url: 'https://example.test', title: 'Source', excerpt: 'Evidence.' },
  ];
  const chain = buildEvidenceChain(source);
  assert.equal(chain.itemCount, 2);
  assert.equal(chain.evidence.at(-1)?.kind, 'evidence_chain');
  assert.equal(verifyEvidenceChain(chain.evidence), true);
  assert.equal(verifyEvidenceChain(JSON.parse(JSON.stringify(chain.evidence))), true);
  assert.deepEqual(buildEvidenceChain(source), chain);
});

test('evidence chain detects altered items, links, root markers, and missing markers', () => {
  const original = buildEvidenceChain([{ kind: 'source', url: 'https://example.test', title: 'Source' }]).evidence;
  const altered = structuredClone(original);
  altered[0]!.title = 'Tampered';
  assert.equal(verifyEvidenceChain(altered), false);
  const brokenLink = structuredClone(original);
  (brokenLink[0] as unknown as { chain: { chainHash: string } }).chain.chainHash = '0'.repeat(64);
  assert.equal(verifyEvidenceChain(brokenLink), false);
  const brokenRoot = structuredClone(original);
  (brokenRoot[1] as unknown as { rootHash: string }).rootHash = 'f'.repeat(64);
  assert.equal(verifyEvidenceChain(brokenRoot), false);
  assert.equal(verifyEvidenceChain(original.slice(0, -1)), false);
});

test('an empty chain has a verifiable, deterministic root marker', () => {
  const chain = buildEvidenceChain([]);
  assert.equal(chain.itemCount, 0);
  assert.equal(chain.evidence.length, 1);
  assert.equal(verifyEvidenceChain(chain.evidence), true);
});
