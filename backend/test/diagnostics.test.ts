import test from 'node:test';
import assert from 'node:assert/strict';
import { redactDiagnosticText, validateMigrationSequence } from '../src/scripts/diagnostics.js';

test('diagnostic redaction masks credential-like values and bounds captured output', () => {
  const safe = redactDiagnosticText('API_KEY=super-secret Authorization: Bearer abc.def DATABASE_URL=postgres://user:password@host/db');
  assert.equal(safe.includes('super-secret'), false);
  assert.equal(safe.includes('abc.def'), false);
  assert.equal(safe.includes('postgres://'), false);
  assert.ok(safe.includes('[REDACTED]'));
  assert.ok(redactDiagnosticText('x'.repeat(20_000)).length <= 8_000);
});

test('diagnostics validates unique, contiguous migration filenames without touching a database', () => {
  assert.deepEqual(validateMigrationSequence(['001_initial.sql', '002_changes.sql', '003_artifacts.sql']), {
    valid: true,
    reason: '3 ordered migrations found.',
  });
  assert.equal(validateMigrationSequence(['001_initial.sql', '003_gap.sql']).valid, false);
  assert.equal(validateMigrationSequence(['001_initial.sql', '001_duplicate.sql']).valid, false);
  assert.equal(validateMigrationSequence(['migration.sql']).valid, false);
});
