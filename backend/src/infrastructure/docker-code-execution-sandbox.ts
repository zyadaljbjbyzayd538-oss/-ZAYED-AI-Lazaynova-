import { execFile } from 'node:child_process';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError } from '../domain/errors.js';
import type { CodeExecutionSandbox, SandboxExecutionRequest, SandboxExecutionResult } from '../application/sandbox-port.js';

const MAX_TIMEOUT_MS = 120_000;
const MAX_MEMORY_MB = 2_048;
const MIN_CPU_QUOTA = 1_000;
const MAX_CPU_QUOTA = 200_000;
const MAX_COMMAND_LENGTH = 64 * 1_024;
const MAX_OUTPUT_BYTES = 1 * 1_024 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_DIGEST_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64}$/;

export interface DockerSandboxConfig {
  dockerBinary: string;
  workspaceRoot: string;
  image: string;
  runtime: string;
  commandTimeoutGraceMs?: number;
}

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  errorCode?: string;
  timedOut?: boolean;
  aborted?: boolean;
}

export type DockerCommandRunner = (
  binary: string,
  args: string[],
  options: { timeoutMs: number; maxBufferBytes: number; signal?: AbortSignal; input?: string },
) => Promise<DockerCommandResult>;

/**
 * Runs untrusted commands inside a digest-pinned, locally provisioned image and the gVisor `runsc`
 * runtime. It has no network, no host secrets, a read-only rootfs, and a single per-run workspace mount.
 * The workspace key must already identify an extracted, owner-scoped workspace directory.
 */
export class DockerCodeExecutionSandbox implements CodeExecutionSandbox {
  private readonly workspaceRoot: string;
  private readonly commandTimeoutGraceMs: number;

  constructor(
    private readonly config: DockerSandboxConfig,
    private readonly runCommand: DockerCommandRunner = runDockerCommand,
  ) {
    if (!path.isAbsolute(config.dockerBinary) || /[\u0000-\r\n]/.test(config.dockerBinary)) {
      throw new Error('CODE_SANDBOX_DOCKER_BINARY must be an absolute executable path.');
    }
    if (!path.isAbsolute(config.workspaceRoot) || /[\u0000-\r\n]/.test(config.workspaceRoot)) {
      throw new Error('CODE_SANDBOX_WORKSPACE_ROOT must be an absolute path.');
    }
    if (!IMAGE_DIGEST_PATTERN.test(config.image)) {
      throw new Error('CODE_SANDBOX_IMAGE must be pinned to a sha256 digest.');
    }
    if (config.runtime !== 'runsc') {
      throw new Error('CODE_SANDBOX_RUNTIME must be runsc; an unconfined Docker runtime is not accepted.');
    }
    const grace = config.commandTimeoutGraceMs ?? 5_000;
    if (!Number.isInteger(grace) || grace < 1_000 || grace > 15_000) {
      throw new Error('Sandbox command timeout grace must be between 1000 and 15000 ms.');
    }
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    this.commandTimeoutGraceMs = grace;
  }

  async isReady(): Promise<boolean> {
    try {
      const info = await this.runCommand(this.config.dockerBinary, ['info', '--format', '{{json .Runtimes}}'], {
        timeoutMs: 2_000,
        maxBufferBytes: 64 * 1_024,
      });
      if (info.exitCode !== 0 || info.timedOut || info.aborted) return false;
      const runtimes: unknown = JSON.parse(info.stdout);
      if (!runtimes || typeof runtimes !== 'object' || !Object.hasOwn(runtimes, this.config.runtime)) return false;

      const image = await this.runCommand(this.config.dockerBinary, ['image', 'inspect', this.config.image, '--format', '{{.Id}}'], {
        timeoutMs: 2_000,
        maxBufferBytes: 8 * 1_024,
      });
      return image.exitCode === 0 && !image.timedOut && !image.aborted && /^sha256:[0-9a-f]{64}\s*$/i.test(image.stdout);
    } catch {
      return false;
    }
  }

  async execute(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    validateRequest(request);
    if (request.networkAccess !== 'NONE') {
      throw new HttpError(501, 'SANDBOX_NETWORK_POLICY_UNAVAILABLE', 'This sandbox only supports fully disabled network access.');
    }
    if (signal?.aborted) throw new HttpError(409, 'SANDBOX_EXECUTION_CANCELLED', 'The sandbox execution was cancelled.');

    const { workspacePath, uid, gid } = await this.resolveWorkspace(request.workspaceArchiveKey, request.userId, request.projectId);
    const startedAt = new Date().toISOString();
    const containerName = `lazaynova-sandbox-${randomUUID()}`;
    const args = [
      'run',
      '--name', containerName,
      '--interactive',
      '--pull', 'never',
      '--runtime', this.config.runtime,
      '--network', 'none',
      '--read-only',
      '--init',
      '--ipc', 'private',
      '--user', `${uid}:${gid}`,
      '--workdir', '/workspace',
      '--mount', `type=bind,source=${workspacePath},target=/workspace,rw,bind-propagation=rprivate`,
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=67108864',
      '--tmpfs', '/run:rw,noexec,nosuid,nodev,size=8388608',
      '--memory', `${request.memoryMb}m`,
      '--memory-swap', `${request.memoryMb}m`,
      '--cpu-period', '100000',
      '--cpu-quota', String(request.cpuQuota),
      '--pids-limit', '128',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true',
      '--ulimit', 'core=0:0',
      '--ulimit', 'nofile=64:64',
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      this.config.image,
      '/bin/sh', '-s',
    ];

    let execution: DockerCommandResult | undefined;
    let executionError: unknown;
    try {
      execution = await this.runCommand(this.config.dockerBinary, args, {
        timeoutMs: request.timeoutMs + this.commandTimeoutGraceMs,
        maxBufferBytes: MAX_OUTPUT_BYTES,
        input: request.command,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      executionError = error;
    }

    if (execution?.errorCode === 'ENOENT' || execution?.errorCode === 'EACCES') {
      throw new HttpError(503, 'SANDBOX_EXECUTION_UNAVAILABLE', 'The isolated execution engine is not available.');
    }

    try {
      await this.removeContainer(containerName);
    } catch {
      throw new HttpError(503, 'SANDBOX_CLEANUP_FAILED', 'The sandbox could not confirm removal of its isolated container.');
    }

    const completedAt = new Date().toISOString();
    if (executionError || !execution) {
      if (signal?.aborted) throw new HttpError(409, 'SANDBOX_EXECUTION_CANCELLED', 'The sandbox execution was cancelled.');
      throw new HttpError(503, 'SANDBOX_EXECUTION_UNAVAILABLE', 'The isolated execution engine could not complete the request.');
    }
    if (execution.aborted || signal?.aborted) {
      throw new HttpError(409, 'SANDBOX_EXECUTION_CANCELLED', 'The sandbox execution was cancelled.');
    }
    if (execution.timedOut || execution.errorCode === 'ETIMEDOUT') {
      return this.result(request, startedAt, completedAt, 124, execution.stdout, execution.stderr, true);
    }
    if (execution.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      throw new HttpError(413, 'SANDBOX_OUTPUT_LIMIT_EXCEEDED', 'Sandbox output exceeded the configured output limit.');
    }
    if (execution.exitCode === 125 || execution.exitCode === null) {
      throw new HttpError(503, 'SANDBOX_EXECUTION_UNAVAILABLE', 'The isolated execution engine could not start the request.');
    }
    return this.result(request, startedAt, completedAt, execution.exitCode, execution.stdout, execution.stderr, false);
  }

  private async resolveWorkspace(key: string, userId: string, projectId: string): Promise<{ workspacePath: string; uid: number; gid: number }> {
    if (!UUID_PATTERN.test(key) || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(projectId)) {
      throw new HttpError(400, 'SANDBOX_WORKSPACE_INVALID', 'The sandbox workspace reference is invalid.');
    }
    let root: string;
    let candidate: string;
    let stats;
    try {
      root = await realpath(this.workspaceRoot);
      candidate = path.join(root, userId, projectId, key);
      stats = await lstat(candidate);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Not a real workspace directory.');
      const resolved = await realpath(candidate);
      if (!resolved.startsWith(`${root}${path.sep}`) || resolved !== candidate) throw new Error('Workspace escaped its configured root.');
      await access(candidate, 2);
    } catch {
      throw new HttpError(404, 'SANDBOX_WORKSPACE_UNAVAILABLE', 'The isolated workspace is unavailable.');
    }
    if (!Number.isSafeInteger(stats.uid) || !Number.isSafeInteger(stats.gid) || stats.uid <= 0 || stats.gid <= 0) {
      throw new HttpError(503, 'SANDBOX_WORKSPACE_UNSAFE_OWNER', 'The isolated workspace has an unsupported owner.');
    }
    if (/[,:\r\n]/.test(root)) {
      throw new HttpError(503, 'SANDBOX_WORKSPACE_PATH_UNSUPPORTED', 'The configured workspace path cannot be mounted safely.');
    }
    return { workspacePath: candidate, uid: stats.uid, gid: stats.gid };
  }

  private async removeContainer(name: string): Promise<void> {
    const result = await this.runCommand(this.config.dockerBinary, ['container', 'rm', '--force', name], {
      timeoutMs: 3_000,
      maxBufferBytes: 8 * 1_024,
    });
    if (result.exitCode === 0) return;
    if (result.exitCode === 1 && /no such container/i.test(result.stderr)) return;
    throw new Error('Container cleanup could not be confirmed.');
  }

  private result(
    request: SandboxExecutionRequest,
    startedAt: string,
    completedAt: string,
    exitCode: number,
    stdout: string,
    stderr: string,
    timedOut: boolean,
  ): SandboxExecutionResult {
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      workspaceArchiveKey: request.workspaceArchiveKey,
      startedAt,
      completedAt,
    };
  }
}

export class UnavailableCodeExecutionSandbox implements CodeExecutionSandbox {
  async isReady(): Promise<boolean> { return false; }

  async execute(_request: SandboxExecutionRequest): Promise<SandboxExecutionResult> {
    throw new HttpError(501, 'SANDBOX_UNAVAILABLE', 'No isolated code execution engine is configured.');
  }
}

export function createCodeExecutionSandboxFromEnvironment(env: NodeJS.ProcessEnv = process.env): CodeExecutionSandbox {
  const dockerBinary = env.CODE_SANDBOX_DOCKER_BINARY?.trim();
  const workspaceRoot = env.CODE_SANDBOX_WORKSPACE_ROOT?.trim();
  const image = env.CODE_SANDBOX_IMAGE?.trim();
  const runtime = env.CODE_SANDBOX_RUNTIME?.trim();
  const values = [dockerBinary, workspaceRoot, image, runtime];
  if (values.every((value) => !value)) return new UnavailableCodeExecutionSandbox();
  if (values.some((value) => !value)) {
    throw new Error('CODE_SANDBOX_DOCKER_BINARY, CODE_SANDBOX_WORKSPACE_ROOT, CODE_SANDBOX_IMAGE, and CODE_SANDBOX_RUNTIME must be configured together.');
  }
  return new DockerCodeExecutionSandbox({ dockerBinary: dockerBinary!, workspaceRoot: workspaceRoot!, image: image!, runtime: runtime! });
}

function validateRequest(request: SandboxExecutionRequest): void {
  if (typeof request.command !== 'string' || request.command.length === 0 || request.command.length > MAX_COMMAND_LENGTH || /\u0000/.test(request.command)) {
    throw new HttpError(400, 'SANDBOX_COMMAND_INVALID', 'The sandbox command is invalid.');
  }
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS) {
    throw new HttpError(400, 'SANDBOX_LIMITS_INVALID', 'The sandbox time limit is invalid.');
  }
  if (!Number.isInteger(request.memoryMb) || request.memoryMb < 64 || request.memoryMb > MAX_MEMORY_MB) {
    throw new HttpError(400, 'SANDBOX_LIMITS_INVALID', 'The sandbox memory limit is invalid.');
  }
  if (!Number.isInteger(request.cpuQuota) || request.cpuQuota < MIN_CPU_QUOTA || request.cpuQuota > MAX_CPU_QUOTA) {
    throw new HttpError(400, 'SANDBOX_LIMITS_INVALID', 'The sandbox CPU limit is invalid.');
  }
}

export const runDockerCommand: DockerCommandRunner = (binary, args, options) => new Promise((resolve) => {
  const child = execFile(binary, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    killSignal: 'SIGKILL',
    ...(options.signal ? { signal: options.signal } : {}),
  }, (error, stdout, stderr) => {
    const typedError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
    const result: DockerCommandResult = {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode: typeof typedError?.code === 'number' ? typedError.code : (typedError ? null : 0),
      ...(typeof typedError?.code === 'string' ? { errorCode: typedError.code } : {}),
      ...(typedError?.code === 'ETIMEDOUT' || (typedError?.killed === true && !options.signal?.aborted) ? { timedOut: true } : {}),
      ...(options.signal?.aborted ? { aborted: true } : {}),
    };
    resolve(result);
  });
  if (options.input !== undefined && child.stdin) {
    child.stdin.once('error', () => undefined);
    child.stdin.end(options.input);
  }
});
