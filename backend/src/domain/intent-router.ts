import type { Capability } from './types.js';

export type RoutedIntent =
  | { kind: 'DIRECT_CHAT'; capability: 'CHAT' }
  | { kind: 'TASK'; capability: Exclude<Capability, 'CHAT'> };

const ROUTES: ReadonlyArray<{ capability: Exclude<Capability, 'CHAT'>; patterns: RegExp[] }> = [
  {
    capability: 'FILE_ANALYSIS',
    patterns: [/\b(analy[sz]e|summari[sz]e|review)\b.*\b(pdf|document|file|spreadsheet|image)\b/i, /\b(pdf|document|file|spreadsheet)\b.*\b(analy[sz]e|summari[sz]e|review)\b/i, /حلل.*(ملف|pdf|مستند|صورة|جدول)|لخص.*(ملف|pdf|مستند)/i],
  },
  {
    capability: 'WEB_RESEARCH',
    patterns: [/\b(research|search|look up|find sources|browse the web)\b/i, /ابحث|بحث معمق|مصادر حديثة/i],
  },
  {
    capability: 'PROJECT',
    patterns: [/\b(create|build|scaffold)\b.*\b(app|application|project|website)\b/i, /أنشئ.*(تطبيق|مشروع|موقع)|ابنِ.*(تطبيق|مشروع)/i],
  },
  {
    capability: 'CODING',
    patterns: [/\b(write|debug|refactor|implement|explain)\b.*\b(code|function|script|class|bug)\b/i, /اكتب.*(كود|دالة|برنامج)|أصلح.*(كود|خطأ برمجي)/i],
  },
  {
    capability: 'WRITING',
    patterns: [/\b(write|draft|rewrite|compose)\b.*\b(email|letter|message|essay|post|proposal)\b/i, /اكتب.*(رسالة|بريد|مقال|منشور|خطاب)|صغ.*(رسالة|بريد)/i],
  },
];

/** Deterministic routing only; this selects a capability and never generates an answer. */
export function routeIntent(text: string): RoutedIntent {
  for (const route of ROUTES) {
    if (route.patterns.some((pattern) => pattern.test(text))) {
      return { kind: 'TASK', capability: route.capability };
    }
  }
  return { kind: 'DIRECT_CHAT', capability: 'CHAT' };
}
