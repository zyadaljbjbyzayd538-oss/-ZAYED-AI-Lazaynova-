import type { AgentResult, Capability, VerificationResult } from './types.js';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/i.test(value);

const isCommitHash = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

const safeRelativePath = (value: unknown): value is string =>
  nonEmptyString(value) && !value.startsWith('/') && !/^[a-z]:\\/i.test(value) && !value.split(/[\\/]/).includes('..');

function validHttpUrl(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function validIsoTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && value.includes('T') && !Number.isNaN(Date.parse(value));
}

function nonEmptyRecord(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return record !== null && Object.keys(record).length > 0;
}

/** Evidence gate: drivers cannot complete a task without capability-specific provenance. */
export function verifyResult(capability: Capability, result: AgentResult, checkedAt = new Date().toISOString()): VerificationResult {
  const issues: string[] = [];
  const resultRecord = asRecord(result);
  const rawEvidence: unknown = resultRecord?.evidence;
  const evidence = Array.isArray(rawEvidence)
    ? rawEvidence.filter((item): item is AgentResult['evidence'][number] => {
      const record = asRecord(item);
      return record !== null && nonEmptyString(record.kind);
    })
    : [];
  if (!Array.isArray(rawEvidence) || evidence.length !== rawEvidence.length) issues.push('EVIDENCE_ITEMS_INVALID');

  if (capability === 'WEB_RESEARCH') {
    const citations = evidence.filter((item) => item.kind === 'source');
    const hasCitation = citations.some((item) => validHttpUrl(item.url) && nonEmptyString(item.title) && nonEmptyString(item.excerpt));
    const hasCapture = evidence.some((item) =>
      item.kind === 'research_capture' &&
      Array.isArray(item.urls) && item.urls.length > 0 && item.urls.every(validHttpUrl) &&
      validIsoTimestamp(item.fetched_at) && isSha256(item.raw_source_hash),
    );
    if (!hasCitation || !hasCapture) issues.push('WEB_RESEARCH_REQUIRES_CITATION_AND_FETCHED_SOURCE_HASH');
  }

  if (capability === 'FILE_ANALYSIS') {
    const hasFileEvidence = evidence.some((item) =>
      item.kind === 'file_reference' &&
      nonEmptyString(item.fileId) &&
      nonEmptyString(item.extractorVersion) &&
      Number.isInteger(item.parsed_pages) && Number(item.parsed_pages) >= 1 &&
      nonEmptyString(item.excerpt) && isSha256(item.sha256),
    );
    if (!hasFileEvidence) issues.push('FILE_ANALYSIS_REQUIRES_FILE_ID_EXTRACTOR_VERSION_PAGE_COUNT_EXCERPT_AND_HASH');
    const hasModelExecution = evidence.some((item) =>
      item.kind === 'model_execution' &&
      nonEmptyString(item.provider) && nonEmptyString(item.model) && nonEmptyString(item.modelVersion) &&
      nonEmptyString(item.requestId) && isSha256(item.inputSha256) && isSha256(item.outputSha256),
    );
    if (!hasModelExecution) issues.push('FILE_ANALYSIS_REQUIRES_MODEL_PROVENANCE');
  }

  if (capability === 'CODING') {
    const hasArtifact = evidence.some((item) => item.kind === 'code_artifact' && safeRelativePath(item.path) && isSha256(item.sha256));
    const hasSandboxRun = evidence.some((item) =>
      item.kind === 'sandbox_run' &&
      nonEmptyString(item.sandboxRunId) &&
      item.exitCode === 0 &&
      typeof item.stdout === 'string' &&
      nonEmptyRecord(item.testResults),
    );
    const hasPassingTestReport = evidence.some((item) => item.kind === 'test_report' && item.passed === true && nonEmptyString(item.command));
    if (!hasArtifact) issues.push('CODING_REQUIRES_HASHED_CODE_ARTIFACT');
    if (!hasSandboxRun) issues.push('CODING_REQUIRES_SUCCESSFUL_SANDBOX_RUN');
    if (!hasPassingTestReport) issues.push('CODING_REQUIRES_PASSING_TEST_REPORT');
  }

  if (capability === 'PROJECT') {
    const hasManifest = evidence.some((item) => item.kind === 'project_manifest' && nonEmptyString(item.manifestId) && isSha256(item.digest));
    const hasArtifact = evidence.some((item) => item.kind === 'project_artifact' && nonEmptyString(item.artifactReference) && isCommitHash(item.workspaceCommitHash));
    const hasPassingValidation = evidence.some((item) => item.kind === 'project_validation' && item.passed === true && nonEmptyString(item.command));
    if (!hasManifest) issues.push('PROJECT_REQUIRES_DIGESTED_MANIFEST');
    if (!hasArtifact) issues.push('PROJECT_REQUIRES_ARTIFACT_REFERENCE_AND_COMMIT_HASH');
    if (!hasPassingValidation) issues.push('PROJECT_REQUIRES_PASSING_VALIDATION');
  }

  if (capability === 'MODEL_ANALYSIS') {
    const hasModelProvenance = evidence.some((item) =>
      item.kind === 'model_execution' &&
      nonEmptyString(item.provider) && nonEmptyString(item.model) && nonEmptyString(item.modelVersion) &&
      nonEmptyString(item.requestId) && isSha256(item.inputSha256) && isSha256(item.outputSha256),
    );
    if (!hasModelProvenance) issues.push('MODEL_ANALYSIS_REQUIRES_MODEL_AND_INPUT_OUTPUT_PROVENANCE');
  }

  if (capability === 'WRITING' && (!asRecord(resultRecord?.result) || !nonEmptyString(asRecord(resultRecord?.result)?.text))) {
    issues.push('WRITING_REQUIRES_NON_EMPTY_TEXT_RESULT');
  }

  return { passed: issues.length === 0, checkedAt, evidence, issues };
}
