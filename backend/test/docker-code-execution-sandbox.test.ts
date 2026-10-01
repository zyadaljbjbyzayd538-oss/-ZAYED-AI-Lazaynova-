import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpError } from '../src/domain/errors.js';
import { DockerCodeExecutionSandbox, createCodeExecutionSandboxFromEnvironment, runDockerCommand, type DockerCommandResult } from '../src/infrastructure/docker-code-execution-sandbox.js';

const workspaceKey = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const projectId = '323e4567-e89b-42d3-a456-426614174000';
const image = `registry.example/sandbox@sha256:${'a'.repeat(64)}`;

async function makeSandbox(run: (args: string[], options: { input?: string; timeoutMs: number }) => DockerCommandResult | Promise<DockerCommandResult>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lazaynova-sandbox-test-'));
  const workspace = path.join(root, userId, projectId, workspaceKey);
  await mkdir(workspace, { recursive: true });
  const calls: Array<{ args: string[]; options: { input?: string; timeoutMs: number } }> = [];
  const sandbox = new DockerCodeExecutionSandbox({
    dockerBinary: '/usr/bin/docker',
    workspaceRoot: root,
    image,
    runtime: 'runsc',
  }, async (_binary, args, options) => {
    const safeOptions = { timeoutMs: options.timeoutMs, ...(options.input !== undefined ? { input: options.input } : {}) };
    calls.push({ args, options: safeOptions });
    return run(args, safeOptions);
  });
  return { root, workspace, sandbox, calls };
}

function request(overrides: Partial<Parameters<DockerCodeExecutionSandbox['execute']>[0]> = {}) {
  return {
    projectId,
    userId,
    command: 'echo isolated',
    workspaceArchiveKey: workspaceKey,
    timeoutMs: 10_000,
    memoryMb: 256,
    cpuQuota: 100_000,
    networkAccess: 'NONE' as const,
    ...overrides,
  };
}

test('sandbox executes a command only with gVisor, no network, and constrained container options', async () => {
  const { root, sandbox, calls } = await makeSandbox((args) => args[0] === 'container'
    ? { exitCode: 0, stdout: '', stderr: '' }
    : { exitCode: 0, stdout: 'isolated\n', stderr: '' });
  try {
    const result = await sandbox.execute(request());
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'isolated\n');
    assert.equal(result.workspaceArchiveKey, workspaceKey);
    assert.equal(calls.length, 2);
    const run = calls[0]!;
    assert.equal(run.args[0], 'run');
    assert.ok(run.args.includes('--runtime') && run.args[run.args.indexOf('--runtime') + 1] === 'runsc');
    assert.ok(run.args.includes('--network') && run.args[run.args.indexOf('--network') + 1] === 'none');
    assert.ok(run.args.includes('--read-only'));
    assert.ok(run.args.includes('--cap-drop') && run.args[run.args.indexOf('--cap-drop') + 1] === 'ALL');
    assert.ok(run.args.includes('--memory') && run.args[run.args.indexOf('--memory') + 1] === '256m');
    assert.deepEqual(run.args.slice(-2), ['/bin/sh', '-s']);
    assert.equal(run.options.input, 'echo isolated');
    assert.equal(calls[1]!.args[0], 'container');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox rejects allowlisted network access instead of silently granting egress', async () => {
  const { root, sandbox, calls } = await makeSandbox(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  try {
    await assert.rejects(
      () => sandbox.execute(request({ networkAccess: 'ALLOWLIST' })),
      (error: unknown) => error instanceof HttpError && error.code === 'SANDBOX_NETWORK_POLICY_UNAVAILABLE',
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox rejects invalid workspace keys and symbolic-link workspace directories', async () => {
  const { root, workspace, sandbox, calls } = await makeSandbox(() => ({ exitCode: 0, stdout: '', stderr: '' }));
  try {
    await assert.rejects(() => sandbox.execute(request({ workspaceArchiveKey: '../outside' })), HttpError);
    await rm(workspace, { recursive: true, force: true });
    await symlink(os.tmpdir(), workspace);
    await assert.rejects(
      () => sandbox.execute(request()),
      (error: unknown) => error instanceof HttpError && error.code === 'SANDBOX_WORKSPACE_UNAVAILABLE',
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox reports command timeout distinctly and always removes its container', async () => {
  const { root, sandbox, calls } = await makeSandbox((args) => args[0] === 'container'
    ? { exitCode: 0, stdout: '', stderr: '' }
    : { exitCode: null, stdout: 'partial', stderr: '', timedOut: true });
  try {
    const result = await sandbox.execute(request());
    assert.equal(result.exitCode, 124);
    assert.equal(result.timedOut, true);
    assert.equal(calls.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox treats failed container cleanup as unavailable, not as a successful run', async () => {
  const { root, sandbox } = await makeSandbox((args) => args[0] === 'container'
    ? { exitCode: 1, stdout: '', stderr: 'daemon is unreachable' }
    : { exitCode: 0, stdout: 'looks successful', stderr: '' });
  try {
    await assert.rejects(
      () => sandbox.execute(request()),
      (error: unknown) => error instanceof HttpError && error.code === 'SANDBOX_CLEANUP_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox readiness requires an advertised runsc runtime and the exact pinned image locally', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lazaynova-sandbox-ready-'));
  try {
    const commands: string[][] = [];
    const sandbox = new DockerCodeExecutionSandbox({ dockerBinary: '/usr/bin/docker', workspaceRoot: root, image, runtime: 'runsc' }, async (_binary, args) => {
      commands.push(args);
      if (args[0] === 'info') return { exitCode: 0, stdout: '{"runc":{},"runsc":{}}', stderr: '' };
      return { exitCode: 0, stdout: `sha256:${'b'.repeat(64)}\n`, stderr: '' };
    });
    assert.equal(await sandbox.isReady(), true);
    assert.equal(commands.length, 2);
    const missingRuntime = new DockerCodeExecutionSandbox({ dockerBinary: '/usr/bin/docker', workspaceRoot: root, image, runtime: 'runsc' }, async (_binary, args) =>
      args[0] === 'info'
        ? { exitCode: 0, stdout: '{"runc":{}}', stderr: '' }
        : { exitCode: 0, stdout: `sha256:${'b'.repeat(64)}`, stderr: '' });
    assert.equal(await missingRuntime.isReady(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('sandbox environment factory remains explicitly unavailable when not configured', async () => {
  const sandbox = createCodeExecutionSandboxFromEnvironment({});
  assert.equal(await sandbox.isReady(), false);
  await assert.rejects(() => sandbox.execute(request()), (error: unknown) => error instanceof HttpError && error.code === 'SANDBOX_UNAVAILABLE');
});

test('Docker command runner streams source through stdin and returns bounded child output', async () => {
  const source = 'command text must not be added to the child argv';
  const result = await runDockerCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    timeoutMs: 5_000,
    maxBufferBytes: 1_024,
    input: source,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, source);
  assert.equal(result.timedOut, undefined);
});

test('Docker command runner kills and marks an aborted host-side child process', async () => {
  const controller = new AbortController();
  const child = runDockerCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5_000,
    maxBufferBytes: 1_024,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20).unref();
  const result = await child;
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
});
