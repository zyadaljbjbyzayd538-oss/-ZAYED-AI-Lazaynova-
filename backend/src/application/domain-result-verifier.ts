import { verifyResult } from '../domain/verifier.js';
import type { AgentExecutionContext, AgentResult } from '../domain/types.js';
import type { ResultVerifier } from './orchestration-ports.js';

export class DomainResultVerifier implements ResultVerifier {
  async verify(capability: AgentExecutionContext['capability'], result: AgentResult): Promise<{
    passed: boolean;
    evidence: AgentResult['evidence'];
    issues: string[];
  }> {
    const verification = verifyResult(capability, result);
    return { passed: verification.passed, evidence: verification.evidence, issues: verification.issues };
  }
}
