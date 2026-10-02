import test from 'node:test';
import assert from 'node:assert/strict';
import { routeIntent } from '../src/domain/intent-router.js';

test('simple Arabic greeting routes to direct chat without queueing', () => {
  assert.deepEqual(routeIntent('السلام عليكم'), { kind: 'DIRECT_CHAT', capability: 'CHAT' });
});

test('ordinary informational question routes to direct chat', () => {
  assert.deepEqual(routeIntent('ما هو Android؟'), { kind: 'DIRECT_CHAT', capability: 'CHAT' });
});

test('writing request routes to writing task', () => {
  assert.deepEqual(routeIntent('اكتب رسالة اعتذار رسمية'), { kind: 'TASK', capability: 'WRITING' });
});

test('PDF analysis request routes to file analysis', () => {
  assert.deepEqual(routeIntent('حلل هذا PDF'), { kind: 'TASK', capability: 'FILE_ANALYSIS' });
});

test('research request routes to web research', () => {
  assert.deepEqual(routeIntent('ابحث عن أحدث معلومات حول Kotlin'), { kind: 'TASK', capability: 'WEB_RESEARCH' });
});

test('Android app creation routes to project capability before generic coding', () => {
  assert.deepEqual(routeIntent('أنشئ تطبيق Android'), { kind: 'TASK', capability: 'PROJECT' });
});

test('router is capability selection only, not an answer generator', () => {
  const result = routeIntent('What is Android?');
  assert.equal('answer' in result, false);
});
