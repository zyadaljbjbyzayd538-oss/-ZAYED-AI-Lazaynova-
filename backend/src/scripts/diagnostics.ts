import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Readable } from 'node:stream';
import { buildAiModelCatalogFromEnvironment } from '../infrastructure/agent-composition.js';
import { createCodeExecutionSandboxFromEnvironment } from '../infrastructure/docker-code-execution-sandbox.js';
import { createS3ObjectStorageFromEnvironment } from '../infrastructure/s3-object-storage.js';
import { createPool } from '../infrastructure/postgres.js';
import { redisConnectionFromUrl } from '../infrastructure/redis.js';

export type DiagnosticStatus = 'PASS' | 'FAIL' | 'SKIP';
export interface DiagnosticResult {
  check: string;
  status: DiagnosticStatus;
  summary: string;
  durationMs: number;
  exitCode?: number | null;
  output?: string;
}

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const backendRoot = basename(scriptRoot) === 'dist' ? resolve(scriptRoot, '..') : scriptRoot;
const migrationsRoot = resolve(backendRoot, '../database/migrations');
const reportPath = resolve(backendRoot, '.diagnostics/latest-report.json');
const OUTPUT_LIMIT = 8_000;
const CHILD_TIMEOUT_MS = 15 * 60 * 1_000;
const results: DiagnosticResult[] = [];

export function redactDiagnosticText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?access[_-]?key)?|password|token|database_url|redis_url)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(-OUTPUT_LIMIT);
}

export function validateMigrationSequence(names: string[]): { valid: boolean; reason: string } {
  const numbered = names.map((name) => ({ name, match: /^(\d{3})_[a-z0-9_-]+\.sql$/i.exec(name) }));
  if (numbered.some(({ match }) => !match)) return { valid: false, reason: 'Migration filenames must use NNN_name.sql.' };
  const sorted = numbered
    .map(({ name, match }) => ({ name, number: Number(match![1]) }))
    .sort((left, right) => left.number - right.number);
  if (new Set(sorted.map(({ number }) => number)).size !== sorted.length) return { valid: false, reason: 'Migration numbers must be unique.' };
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index]?.number !== index + 1) return { valid: false, reason: `Migration sequence has a gap before ${sorted[index]?.name ?? 'the next migration'}.` };
  }
  return { valid: true, reason: `${sorted.length} ordered migrations found.` };
}

function addResult(result: DiagnosticResult): void {
  results.push({ ...result, ...(result.output ? { output: redactDiagnosticText(result.output) } : {}) });
  const icon = result.status === 'PASS' ? 'PASS' : result.status === 'SKIP' ? 'SKIP' : 'FAIL';
  console.log(`[${icon}] ${result.check}: ${result.summary} (${result.durationMs} ms)`);
  if (result.output && result.status !== 'PASS') console.log(redactDiagnosticText(result.output));
}

function runNpmScript(check: string, args: string[]): DiagnosticResult {
  const started = Date.now();
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const child = spawnSync(executable, args, {
    cwd: backendRoot,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    shell: false,
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = [child.stdout, child.stderr, child.error?.message].filter(Boolean).join('\n');
  const exitCode = child.status;
  return {
    check,
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    summary: exitCode === 0 ? 'completed' : child.error?.message?.includes('ETIMEDOUT') ? 'timed out' : 'failed; review bounded output',
    durationMs: Date.now() - started,
    exitCode,
    ...(output ? { output } : {}),
  };
}

async function runLocalChecks(): Promise<void> {
  const names = (await readdir(migrationsRoot)).filter((name) => name.endsWith('.sql'));
  const sequence = validateMigrationSequence(names);
  addResult({
    check: 'migration files',
    status: sequence.valid ? 'PASS' : 'FAIL',
    summary: sequence.reason,
    durationMs: 0,
  });
  for (const [label, args] of [
    ['typecheck', ['run', 'typecheck']],
    ['lint', ['run', 'lint']],
    ['tests', ['test']],
    ['build', ['run', 'build']],
  ] as const) {
    addResult(runNpmScript(label, [...args]));
  }
}

async function probePostgres(): Promise<string> {
  const pool = createPool();
  try {
    await pool.query('SELECT 1');
    const applied = await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    const expected = (await readdir(migrationsRoot)).filter((name) => name.endsWith('.sql')).sort();
    const appliedSet = new Set(applied.rows.map((row) => row.name));
    const missing = expected.filter((name) => !appliedSet.has(name));
    if (missing.length) throw new Error('migrations incomplete');
    await pool.query('SELECT id FROM task_artifacts LIMIT 0');
    return `connected; ${expected.length} migrations recorded; task_artifacts is queryable`;
  } finally {
    await pool.end();
  }
}

async function probeRedis(): Promise<string> {
  const connection = { ...redisConnectionFromUrl(), connectTimeout: 3_000, maxRetriesPerRequest: 1, retryStrategy: () => null };
  const queue = new Queue('lazaynova-diagnostics-probe', { connection });
  try {
    await queue.waitUntilReady();
    const client = await queue.client;
    const ping = (client as unknown as { ping?: () => Promise<string> }).ping;
    if (!ping || (await ping.call(client)) !== 'PONG') throw new Error('Redis ping failed');
    return 'BullMQ Redis connection returned PONG; no job was created';
  } finally {
    await queue.close();
  }
}

async function probeArtifactStorage(): Promise<string> {
  const storage = createS3ObjectStorageFromEnvironment(process.env);
  if (!storage) return 'S3-compatible artifact store is not configured';
  const taskId = randomUUID();
  const artifactId = randomUUID();
  const key = `tasks/${taskId}/artifacts/${artifactId}`;
  const body = Buffer.from(JSON.stringify({ diagnostic: 'temporary round-trip probe', nonce: randomUUID() }), 'utf8');
  const sha256 = createHash('sha256').update(body).digest('hex');
  let failure: unknown;
  try {
    if (!(await storage.isReady())) throw new Error('artifact bucket is not reachable');
    await storage.put({ key, body: Readable.from([body]), contentType: 'application/json', byteLength: body.length, sha256 });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of await storage.get(key)) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += value.length;
      if (bytes > 8 * 1024) throw new Error('artifact diagnostic read exceeded its bound');
      chunks.push(value);
    }
    if (!Buffer.concat(chunks).equals(body)) throw new Error('artifact round-trip content mismatch');
  } catch (error) {
    failure = error;
  }
  try {
    // Delete is idempotent for S3 and also cleans up a put that succeeded before a later error.
    await storage.delete(key);
  } catch {
    failure = new Error('artifact diagnostic object cleanup failed');
  } finally {
    storage.close();
  }
  if (failure) throw failure;
  return 'temporary object uploaded, read back byte-for-byte, and deleted';
}

async function probeModels(): Promise<string> {
  const catalog = buildAiModelCatalogFromEnvironment(process.env);
  const profiles = await catalog.listProviderInventories();
  if (profiles.length === 0) return 'no model profiles configured; no provider request made';
  const available = profiles.filter((profile) => profile.availability === 'AVAILABLE').length;
  const failed = profiles.length - available;
  if (failed > 0) throw new Error('one or more configured model profiles did not pass inventory readiness');
  return `${available} configured model profile(s) passed inventory lookup; no generation request was made`;
}

async function probeSandbox(): Promise<string> {
  const names = ['CODE_SANDBOX_DOCKER_BINARY', 'CODE_SANDBOX_WORKSPACE_ROOT', 'CODE_SANDBOX_IMAGE', 'CODE_SANDBOX_RUNTIME'];
  if (names.every((name) => !process.env[name]?.trim())) return 'sandbox is not configured; no container was started';
  const sandbox = createCodeExecutionSandboxFromEnvironment(process.env);
  if (!(await sandbox.isReady())) throw new Error('Docker/gVisor sandbox readiness probe failed');
  return 'digest-pinned image and runsc runtime passed read-only readiness checks; no container was started';
}

async function runLiveChecks(): Promise<void> {
  const liveChecks: Array<[string, () => Promise<string>, boolean]> = [
    ['PostgreSQL and migrations', probePostgres, Boolean(process.env.DATABASE_URL?.trim())],
    ['Redis/BullMQ', probeRedis, Boolean(process.env.REDIS_URL?.trim())],
    ['S3 artifact round-trip', probeArtifactStorage, ['ARTIFACT_S3_BUCKET', 'ARTIFACT_S3_REGION', 'ARTIFACT_S3_ACCESS_KEY_ID', 'ARTIFACT_S3_SECRET_ACCESS_KEY', 'ARTIFACT_S3_ENDPOINT', 'ARTIFACT_S3_FORCE_PATH_STYLE'].some((name) => Boolean(process.env[name]?.trim()))],
    ['AI model inventory', probeModels, Boolean(process.env.AI_GATEWAY_PROVIDERS?.trim() || process.env.AI_GATEWAY_BASE_URL?.trim() || process.env.AI_GATEWAY_MODEL?.trim())],
    ['Docker/gVisor readiness', probeSandbox, ['CODE_SANDBOX_DOCKER_BINARY', 'CODE_SANDBOX_WORKSPACE_ROOT', 'CODE_SANDBOX_IMAGE', 'CODE_SANDBOX_RUNTIME'].some((name) => Boolean(process.env[name]?.trim()))],
  ];
  for (const [check, probe, configured] of liveChecks) {
    if (!configured) {
      addResult({ check, status: 'SKIP', summary: 'required server configuration is absent; no live request was made', durationMs: 0 });
      continue;
    }
    const started = Date.now();
    try {
      addResult({ check, status: 'PASS', summary: await probe(), durationMs: Date.now() - started });
    } catch (error) {
      const safeOutput = error instanceof Error ? redactDiagnosticText(error.message) : 'unknown live probe error';
      addResult({ check, status: 'FAIL', summary: 'live probe failed; credentials are withheld', durationMs: Date.now() - started, output: safeOutput });
    }
  }
}

async function saveReport(mode: string): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    results,
    summary: {
      passed: results.filter((item) => item.status === 'PASS').length,
      failed: results.filter((item) => item.status === 'FAIL').length,
      skipped: results.filter((item) => item.status === 'SKIP').length,
    },
    note: 'This report contains bounded, redacted diagnostics. It is local-only and is never uploaded.',
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Redacted report written to ${reportPath}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'check';
  if (!['check', 'repair', 'live', 'live-only'].includes(mode)) {
    console.error('Usage: npm run diagnose | npm run diagnose:repair -- --confirm-owner | npm run diagnose:live | npm run diagnose:live-services');
    process.exitCode = 2;
    return;
  }
  if (mode === 'repair' && !process.argv.includes('--confirm-owner')) {
    console.error('Refusing repair mode without explicit owner confirmation: pass --confirm-owner.');
    process.exitCode = 2;
    return;
  }

  if (mode === 'repair') {
    console.log('Owner-confirmed repair is limited to ESLint safe auto-fixes; no arbitrary commands, migrations, or AI-generated code changes are permitted.');
    addResult(runNpmScript('safe lint auto-fix', ['run', 'lint', '--', '--fix']));
  }
  if (mode !== 'live-only') await runLocalChecks();
  if (mode === 'live' || mode === 'live-only') await runLiveChecks();
  await saveReport(mode);
  const failures = results.filter((item) => item.status === 'FAIL').length;
  if (mode === 'repair') console.log('Review source diffs before deployment; this command does not auto-fix failing tests or business logic.');
  process.exitCode = failures === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
