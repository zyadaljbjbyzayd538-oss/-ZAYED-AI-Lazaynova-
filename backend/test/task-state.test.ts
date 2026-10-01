import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTransition, canTransition } from '../src/domain/task-state.js';

test('permits the expected execution state machine', () => {
  for (const [from, to] of [['QUEUED', 'PLANNING'], ['PLANNING', 'RUNNING'], ['RUNNING', 'VERIFYING'], ['VERIFYING', 'COMPLETED']] as const) {
    assert.equal(canTransition(from, to), true);
    assert.doesNotThrow(() => assertTransition(from, to));
  }
});

test('terminal states cannot restart', () => {
  assert.equal(canTransition('COMPLETED', 'RUNNING'), false);
  assert.equal(canTransition('FAILED', 'QUEUED'), false);
  assert.throws(() => assertTransition('CANCELLED', 'RUNNING'), /Invalid task state transition/);
});
