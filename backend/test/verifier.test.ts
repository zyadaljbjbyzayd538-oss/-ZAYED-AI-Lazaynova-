import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyResult } from '../src/domain/verifier.js';
import type { AgentResult } from '../src/domain/types.js';

const result = (evidence: AgentResult['evidence']): AgentResult => ({ result: { text: 'output' }, evidence });
const researchEvidence: AgentResult['evidence'] = [
  { kind: 'source', url: 'https://example.com/report', title: 'Report', excerpt: 'Relevant evidence.' },
  { kind: 'research_capture', urls: ['https://example.com/report'], fetched_at: '2026-09-29T12:00:00.000Z', raw_source_hash: 'a'.repeat(64) },
];

test('web research requires a cited source plus fetched URLs, timestamp and raw-source hash', () => {
  const noEvidence = verifyResult('WEB_RESEARCH', result([]));
  assert.equal(noEvidence.passed, false);
  assert.ok(noEvidence.issues.includes('WEB_RESEARCH_REQUIRES_CITATION_AND_FETCHED_SOURCE_HASH'));
  assert.equal(verifyResult('WEB_RESEARCH', result(researchEvidence)).passed, true);
});

test('research rejects non-HTTP citations and malformed capture provenance', () => {
  const checked = verifyResult('WEB_RESEARCH', result([
    { kind: 'source', url: 'javascript:alert(1)', title: 'x', excerpt: 'not a citation' },
    { kind: 'research_capture', urls: ['ftp://invalid.test'], fetched_at: 'yesterday', raw_source_hash: 'sha256-a8f5c...9e' },
  ]));
  assert.equal(checked.passed, false);
});

test('file analysis requires source hash and model request provenance', () => {
  assert.equal(verifyResult('FILE_ANALYSIS', result([{ kind: 'file_reference', fileId: 'f-1', excerpt: 'Page 2' }])).passed, false);
  const fileEvidence = [
    { kind: 'file_reference', fileId: 'f-1', extractorVersion: 'utf8-text-v1', parsed_pages: 1, excerpt: 'Quarterly report excerpt', sha256: 'a'.repeat(64) },
    { kind: 'model_execution', provider: 'private', model: 'analyst', modelVersion: 'v1', requestId: 'request-1', inputSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64) },
  ];
  assert.equal(verifyResult('FILE_ANALYSIS', result(fileEvidence)).passed, true);
  assert.equal(verifyResult('FILE_ANALYSIS', result(fileEvidence.slice(0, 1))).passed, false);
  assert.equal(verifyResult('FILE_ANALYSIS', result([
    { kind: 'file_reference', fileId: 'f-1', extractorVersion: 'utf8-text-v1', parsed_pages: 1, excerpt: 'Excerpt', sha256: 'invalid' },
    ...fileEvidence.slice(1),
  ])).passed, false);
});

test('coding requires a hashed artifact, successful sandbox run and passing test report', () => {
  const output = result([
    { kind: 'code_artifact', path: 'src/App.kt', sha256: 'a'.repeat(64) },
    { kind: 'sandbox_run', sandboxRunId: 'run-1', exitCode: 0, stdout: 'BUILD SUCCESSFUL', testResults: { unit: 'passed' } },
    { kind: 'test_report', command: './gradlew test', passed: true },
  ]);
  assert.equal(verifyResult('CODING', output).passed, true);
  assert.equal(verifyResult('CODING', result([
    { kind: 'code_artifact', path: '../outside.kt', sha256: 'a'.repeat(64) },
    { kind: 'sandbox_run', sandboxRunId: 'run-1', exitCode: 0, stdout: '', testResults: { unit: 'passed' } },
    { kind: 'test_report', command: './gradlew test', passed: true },
  ])).passed, false);
});

test('project requires digested manifest, artifact commit and passing validation', () => {
  const checked = verifyResult('PROJECT', result([
    { kind: 'project_manifest', manifestId: 'project-1', digest: 'b'.repeat(64) },
    { kind: 'project_artifact', artifactReference: 's3://workspace/archive.zip', workspaceCommitHash: 'c'.repeat(40) },
    { kind: 'project_validation', command: 'npm test', passed: true },
  ]));
  assert.equal(checked.passed, true);
});

test('model analysis requires model identity and input/output hashes', () => {
  assert.equal(verifyResult('MODEL_ANALYSIS', result([])).passed, false);
  assert.equal(verifyResult('MODEL_ANALYSIS', result([{
    kind: 'model_execution', provider: 'internal', model: 'analyst', modelVersion: 'v1', requestId: 'request-1',
    inputSha256: 'd'.repeat(64), outputSha256: 'e'.repeat(64),
  }])).passed, true);
});

test('writing requires a non-empty text result', () => {
  assert.equal(verifyResult('WRITING', { result: { text: '  ' }, evidence: [] }).passed, false);
  assert.equal(verifyResult('WRITING', { result: { text: 'Draft' }, evidence: [] }).passed, true);
});

test('chat has no task-evidence requirement and verification is timestamped', () => {
  const checked = verifyResult('CHAT', { result: 'real driver output', evidence: [] }, '2026-09-29T00:00:00.000Z');
  assert.equal(checked.passed, true);
  assert.equal(checked.checkedAt, '2026-09-29T00:00:00.000Z');
});
