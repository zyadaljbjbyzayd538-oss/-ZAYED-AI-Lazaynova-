import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import rateLimit from '@fastify/rate-limit';
import websocketPlugin from '@fastify/websocket';
import { z } from 'zod';
import type { SubmitAssistantRequest } from '../application/submit-request.js';
import type { Planner, ToolManager } from '../application/orchestration-ports.js';
import type { TaskEventSource, TaskStatusEvent } from '../application/task-events.js';
import type { WorkflowDefinitionService } from '../application/workflow-definition-service.js';
import type { WorkflowRunService } from '../application/workflow-run-service.js';
import type { AiUsageReader } from '../application/ai-usage-ports.js';
import type { TaskArtifactWriter } from '../application/artifact-ports.js';
import type { AiModelCatalog } from '../application/ai-model-catalog.js';
import { MAX_TEXT_FILE_BASE64_CHARS, SUPPORTED_TEXT_CONTENT_TYPES, type FileService } from '../application/file-ports.js';
import type { AuthRepository, AuditRepository, TaskRepository } from '../application/ports.js';
import { AgentRegistry } from '../domain/agent-registry.js';
import { HttpError } from '../domain/errors.js';
import { CAPABILITIES, TOOL_BUDGETS, TOOL_CAPABILITIES, type AuthenticatedUser, type Capability, type TaskRecord, type ToolName, type UserIdentity } from '../domain/types.js';
import { workflowDefinitionInputSchema, workflowVersionInputSchema } from '../domain/workflow-definition.js';
import { SessionService } from '../auth/session-service.js';
import { hashPassword } from '../auth/password.js';

export interface AppDependencies {
  sessions: SessionService;
  auth: AuthRepository;
  tasks: TaskRepository;
  audit: AuditRepository;
  submit: SubmitAssistantRequest;
  agents: AgentRegistry;
  planner?: Planner;
  tools?: ToolManager;
  files?: FileService;
  workflows?: Pick<WorkflowDefinitionService, 'create' | 'addVersion' | 'list' | 'getLatest' | 'getVersion'>;
  workflowRuns?: Pick<WorkflowRunService, 'start' | 'get' | 'decide' | 'cancel'>;
  aiModelCatalog?: Pick<AiModelCatalog, 'listProviderInventories' | 'listRoutedModels'>;
  taskEvents?: TaskEventSource;
  aiUsage?: Pick<AiUsageReader, 'getUserUsageSummary'>;
  taskArtifacts?: Pick<TaskArtifactWriter, 'readForOwner' | 'deleteForOwner'>;
  rateLimit?: { max: number; timeWindow: string };
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthenticatedUser | null;
    websocketUser: UserIdentity | null;
    websocketTask: TaskRecord | null;
  }
}

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(1_024) }).strict();
const requestSchema = z.object({
  input: z.string().trim().min(1).max(20_000),
  attachments: z.array(z.string().uuid()).max(10).optional(),
}).strict();
const chatMessagesSchema = z.array(z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(20_000),
}).strict()).min(1).max(40).superRefine((messages, context) => {
  if (messages[0]?.role !== 'user' || messages[messages.length - 1]?.role !== 'user') {
    context.addIssue({ code: 'custom', message: 'Conversation must start and end with a user message.' });
  }
  if (messages.some((message, index) => index > 0 && message.role === messages[index - 1]?.role)) {
    context.addIssue({ code: 'custom', message: 'Conversation roles must alternate between user and assistant.' });
  }
  if (messages.reduce((total, message) => total + message.content.length, 0) > 40_000) {
    context.addIssue({ code: 'custom', message: 'Conversation exceeds the total text limit.' });
  }
});
const lazaynovaChatSchema = z.union([
  z.object({ prompt: z.string().trim().min(1).max(20_000) }).strict()
    .transform(({ prompt }) => [{ role: 'user' as const, content: prompt }]),
  z.object({ messages: chatMessagesSchema }).strict().transform(({ messages }) => messages),
]);
const userSchema = z.object({ email: z.string().email().max(320), password: z.string().min(14).max(1_024) }).strict();
const grantSchema = z.object({ enabled: z.boolean() }).strict();
const taskExecutionSchema = z.object({
  capability: z.enum(['WRITING', 'WEB_RESEARCH', 'FILE_ANALYSIS', 'CODING', 'PROJECT', 'MODEL_ANALYSIS']),
  prompt: z.string().trim().min(1).max(20_000),
  params: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.string().uuid()).max(1).optional(),
}).strict();
const fileUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.enum(SUPPORTED_TEXT_CONTENT_TYPES),
  contentBase64: z.string().min(4).max(MAX_TEXT_FILE_BASE64_CHARS),
}).strict();
const idSchema = z.string().uuid();
const workflowApprovalSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).strict();
const workflowStepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return parsed.data;
}

function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${data === '[DONE]' ? '[DONE]' : JSON.stringify(data)}\n\n`;
}

function waitForSsePoll(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{30,})$/.exec(authorization);
  return match?.[1] ?? null;
}

async function requireUser(request: FastifyRequest, dependencies: AppDependencies): Promise<AuthenticatedUser> {
  if (request.authUser) return request.authUser;
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'AUTHENTICATION_REQUIRED', 'A valid bearer session is required.');
  const user = await dependencies.sessions.authenticate(token);
  if (!user) throw new HttpError(401, 'INVALID_SESSION', 'The session is expired, revoked, or invalid.');
  request.authUser = user;
  return user;
}

async function requireAdmin(request: FastifyRequest, dependencies: AppDependencies): Promise<AuthenticatedUser> {
  const user = await requireUser(request, dependencies);
  if (user.role !== 'ADMIN') throw new HttpError(403, 'ADMIN_ROLE_REQUIRED', 'Administrator role is required.');
  return user;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const loggerEnabled = dependencies.logger ?? (process.env.NODE_ENV !== 'test');
  const app = Fastify({
    logger: loggerEnabled ? { redact: { paths: ['req.url', 'req.headers.authorization'], censor: '[REDACTED]' } } : false,
    bodyLimit: 256 * 1024,
  });
  app.decorateRequest('authUser', null);
  app.decorateRequest('websocketUser', null);
  app.decorateRequest('websocketTask', null);
  await app.register(websocketPlugin, { options: { maxPayload: 16 * 1024, perMessageDeflate: false } });
  await app.register(rateLimit, { global: true, max: dependencies.rateLimit?.max ?? 100, timeWindow: dependencies.rateLimit?.timeWindow ?? '1 minute' });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      void reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    const safeClientErrors: Record<number, { code: string; message: string }> = {
      400: { code: 'INVALID_REQUEST', message: 'The request body or parameters are invalid.' },
      404: { code: 'NOT_FOUND', message: 'The requested resource was not found.' },
      413: { code: 'REQUEST_TOO_LARGE', message: 'The request exceeds the allowed size.' },
      415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'The request content type is not supported.' },
      429: { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
    };
    const clientError = safeClientErrors[statusCode];
    if (clientError) {
      void reply.code(statusCode).send({ error: clientError });
      return;
    }
    app.log.error({ err: error }, 'Unhandled request error');
    void reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' } });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/v1/auth/sessions', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const session = await dependencies.sessions.login(body.email, body.password);
    return reply.code(201).send(session);
  });

  app.delete('/v1/auth/session', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    await dependencies.sessions.logout(user);
    return reply.code(204).send();
  });

  app.post('/v1/auth/websocket-tickets', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    const ticket = await dependencies.sessions.issueWebSocketTicket(user);
    return reply.code(201).send(ticket);
  });

  app.get('/v1/agent/capabilities', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    reply.header('cache-control', 'no-store');
    const capabilities = await Promise.all(CAPABILITIES.map(async (capability) => {
      const [grant, readiness] = await Promise.all([
        dependencies.auth.hasCapability(user.id, capability),
        dependencies.agents.readiness(capability),
      ]);
      const plannerReady = capability === 'CHAT' || !dependencies.planner || await dependencies.planner.isReady();
      const requiredTools = (Object.entries(TOOL_CAPABILITIES) as Array<[ToolName, Capability]>)
        .filter(([, requiredCapability]) => requiredCapability === capability);
      const toolGrants = await Promise.all(requiredTools.map(async ([name]) => {
        const budget = TOOL_BUDGETS[name];
        const [granted, usage] = await Promise.all([
          dependencies.auth.hasToolGrant(user.id, name),
          dependencies.auth.getToolUsageStatus(user.id, name, budget.callsPerMinute, budget.callsPerDay),
        ]);
        return { name, granted, usage };
      }));
      return { capability, granted: grant, ready: readiness.ready && plannerReady, toolGrants };
    }));
    return { capabilities };
  });

  app.get('/v1/agent/tools', async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.tools) throw new HttpError(501, 'TOOL_MANAGER_UNAVAILABLE', 'The tool manager is not configured.');
    return { tools: await dependencies.tools.listAvailable(user.id) };
  });

  app.get('/v1/ai/models', async (request) => {
    await requireUser(request, dependencies);
    if (!dependencies.aiModelCatalog) throw new HttpError(501, 'AI_MODEL_CATALOG_UNAVAILABLE', 'The AI model catalog is not configured.');
    return { models: await dependencies.aiModelCatalog.listRoutedModels() };
  });

  app.get('/v1/usage', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.aiUsage) throw new HttpError(501, 'AI_USAGE_UNAVAILABLE', 'Provider usage accounting is not configured.');
    reply.header('cache-control', 'no-store');
    return dependencies.aiUsage.getUserUsageSummary(user.id);
  });

  app.get('/v1/admin/ai/models', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    await requireAdmin(request, dependencies);
    if (!dependencies.aiModelCatalog) throw new HttpError(501, 'AI_MODEL_CATALOG_UNAVAILABLE', 'The AI model catalog is not configured.');
    return { providers: await dependencies.aiModelCatalog.listProviderInventories() };
  });

  app.get('/v1/workflows', async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflows) throw new HttpError(501, 'WORKFLOW_STORE_UNAVAILABLE', 'Workflow definition storage is unavailable.');
    return { workflows: await dependencies.workflows.list(user.id) };
  });

  app.post('/v1/workflows', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflows) throw new HttpError(501, 'WORKFLOW_STORE_UNAVAILABLE', 'Workflow definition storage is unavailable.');
    const body = parseOrThrow(workflowDefinitionInputSchema, request.body);
    const workflow = await dependencies.workflows.create(user.id, body);
    return reply.code(201).send(workflow);
  });

  app.get('/v1/workflows/:workflowId/versions/:version', async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflows) throw new HttpError(501, 'WORKFLOW_STORE_UNAVAILABLE', 'Workflow definition storage is unavailable.');
    const { workflowId, version: rawVersion } = request.params as { workflowId: string; version: string };
    if (!idSchema.safeParse(workflowId).success) throw new HttpError(400, 'INVALID_WORKFLOW_ID', 'Workflow id must be a UUID.');
    if (!/^[1-9][0-9]{0,8}$/.test(rawVersion)) throw new HttpError(400, 'INVALID_WORKFLOW_VERSION', 'Workflow version must be a positive integer.');
    return dependencies.workflows.getVersion(user.id, workflowId, Number(rawVersion));
  });

  app.post('/v1/workflows/:workflowId/versions', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflows) throw new HttpError(501, 'WORKFLOW_STORE_UNAVAILABLE', 'Workflow definition storage is unavailable.');
    const { workflowId } = request.params as { workflowId: string };
    if (!idSchema.safeParse(workflowId).success) throw new HttpError(400, 'INVALID_WORKFLOW_ID', 'Workflow id must be a UUID.');
    const body = parseOrThrow(workflowVersionInputSchema, request.body);
    const workflow = await dependencies.workflows.addVersion(user.id, workflowId, body);
    return reply.code(201).send(workflow);
  });

  app.post('/v1/workflows/:workflowId/runs', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflowRuns) throw new HttpError(501, 'WORKFLOW_RUNNER_UNAVAILABLE', 'Workflow execution is not configured.');
    const { workflowId } = request.params as { workflowId: string };
    if (!idSchema.safeParse(workflowId).success) throw new HttpError(400, 'INVALID_WORKFLOW_ID', 'Workflow id must be a UUID.');
    const run = await dependencies.workflowRuns.start(user.id, workflowId, request.body);
    return reply.code(202).send(run);
  });

  app.get('/v1/workflow-runs/:runId', async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflowRuns) throw new HttpError(501, 'WORKFLOW_RUNNER_UNAVAILABLE', 'Workflow execution is not configured.');
    const { runId } = request.params as { runId: string };
    if (!idSchema.safeParse(runId).success) throw new HttpError(400, 'INVALID_WORKFLOW_RUN_ID', 'Workflow run id must be a UUID.');
    return dependencies.workflowRuns.get(user.id, runId);
  });

  app.get('/v1/workflow-runs/:runId/stream', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflowRuns) throw new HttpError(501, 'WORKFLOW_RUNNER_UNAVAILABLE', 'Workflow execution is not configured.');
    const { runId } = request.params as { runId: string };
    if (!idSchema.safeParse(runId).success) throw new HttpError(400, 'INVALID_WORKFLOW_RUN_ID', 'Workflow run id must be a UUID.');
    await dependencies.workflowRuns.get(user.id, runId);

    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    const events = Readable.from((async function* () {
      let lastProgress = '';
      let lastHeartbeat = Date.now();
      const streamDeadline = Date.now() + 15 * 60_000;
      try {
        while (!abortController.signal.aborted && Date.now() < streamDeadline) {
          const run = await dependencies.workflowRuns!.get(user.id, runId);
          const progress = {
            runId: run.runId,
            status: run.status,
            errorCode: run.errorCode,
            cancelRequested: run.cancelRequested,
            steps: run.steps.map(({ id, capability, status, attempts, errorCode }) => ({ id, capability, status, attempts, errorCode })),
          };
          const serialized = JSON.stringify(progress);
          if (serialized !== lastProgress) {
            lastProgress = serialized;
            yield encodeSse('progress', progress);
          } else if (Date.now() - lastHeartbeat >= 15_000) {
            lastHeartbeat = Date.now();
            yield ': keep-alive\n\n';
          }
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
            yield encodeSse('done', '[DONE]');
            return;
          }
          await waitForSsePoll(abortController.signal, 1_000);
        }
        if (!abortController.signal.aborted) yield encodeSse('reconnect', { retryAfterMs: 1_000 });
      } catch (error) {
        if (!abortController.signal.aborted) {
          const safeError = error instanceof HttpError
            ? { code: error.code, message: error.message }
            : { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' };
          yield encodeSse('error', safeError);
        }
      }
    })());

    return reply.code(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no')
      .send(events);
  });

  app.post('/v1/workflow-runs/:runId/steps/:stepId/approval', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflowRuns) throw new HttpError(501, 'WORKFLOW_RUNNER_UNAVAILABLE', 'Workflow execution is not configured.');
    const { runId, stepId } = request.params as { runId: string; stepId: string };
    if (!idSchema.safeParse(runId).success) throw new HttpError(400, 'INVALID_WORKFLOW_RUN_ID', 'Workflow run id must be a UUID.');
    if (!workflowStepIdSchema.safeParse(stepId).success) throw new HttpError(400, 'INVALID_WORKFLOW_STEP_ID', 'Workflow step id is invalid.');
    const body = parseOrThrow(workflowApprovalSchema, request.body);
    return dependencies.workflowRuns.decide(user.id, runId, stepId, body.decision);
  });

  app.post('/v1/workflow-runs/:runId/cancel', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflowRuns) throw new HttpError(501, 'WORKFLOW_RUNNER_UNAVAILABLE', 'Workflow execution is not configured.');
    const { runId } = request.params as { runId: string };
    if (!idSchema.safeParse(runId).success) throw new HttpError(400, 'INVALID_WORKFLOW_RUN_ID', 'Workflow run id must be a UUID.');
    return dependencies.workflowRuns.cancel(user.id, runId);
  });

  app.get('/v1/workflows/:workflowId', async (request) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.workflows) throw new HttpError(501, 'WORKFLOW_STORE_UNAVAILABLE', 'Workflow definition storage is unavailable.');
    const { workflowId } = request.params as { workflowId: string };
    if (!idSchema.safeParse(workflowId).success) throw new HttpError(400, 'INVALID_WORKFLOW_ID', 'Workflow id must be a UUID.');
    return dependencies.workflows.getLatest(user.id, workflowId);
  });

  app.post('/v1/files', {
    bodyLimit: 48 * 1_024,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!(await dependencies.auth.hasCapability(user.id, 'FILE_ANALYSIS'))) throw new HttpError(403, 'CAPABILITY_PERMISSION_REQUIRED', 'The account is not granted file analysis.');
    if (!dependencies.files || !(await dependencies.files.isReady())) {
      throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted text-file storage is not configured.');
    }
    const body = parseOrThrow(fileUploadSchema, request.body);
    const file = await dependencies.files.createUpload({ userId: user.id, ...body });
    return reply.code(201).send(file);
  });

  app.get('/v1/files/:fileId', async (request) => {
    const user = await requireUser(request, dependencies);
    const { fileId } = request.params as { fileId: string };
    if (!idSchema.safeParse(fileId).success) throw new HttpError(400, 'INVALID_FILE_ID', 'File id must be a UUID.');
    if (!dependencies.files) throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted text-file storage is not configured.');
    return dependencies.files.getMetadata({ userId: user.id, fileId });
  });

  app.delete('/v1/files/:fileId', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    const { fileId } = request.params as { fileId: string };
    if (!idSchema.safeParse(fileId).success) throw new HttpError(400, 'INVALID_FILE_ID', 'File id must be a UUID.');
    if (!dependencies.files) throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted text-file storage is not configured.');
    if (!(await dependencies.files.delete({ userId: user.id, fileId }))) throw new HttpError(404, 'FILE_NOT_FOUND', 'The file was not found.');
    return reply.code(204).send();
  });

  app.post('/v1/lazaynova/chat/stream', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    const body = parseOrThrow(lazaynovaChatSchema, request.body);
    const abortController = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) abortController.abort();
    });
    const conversation = body;
    const latestPrompt = conversation[conversation.length - 1]!.content;
    const upstream = await dependencies.submit.streamChat(
      user,
      { text: latestPrompt, messages: conversation },
      abortController.signal,
    );

    const events = Readable.from((async function* () {
      yield encodeSse('start', { status: 'started' });
      try {
        let hasText = false;
        let completed = false;
        for await (const event of upstream) {
          if (event.type === 'text_delta') {
            hasText = true;
            yield encodeSse('delta', { content: event.content });
          } else {
            completed = true;
            yield encodeSse('result', {
              provenance: {
                provider: event.provider,
                model: event.model,
                requestId: event.requestId,
                ...(event.usage ? { usage: event.usage } : {}),
              },
            });
          }
        }
        if (!hasText || !completed) throw new HttpError(502, 'CHAT_STREAM_INCOMPLETE', 'The Chat provider stream ended before completion.');
        yield encodeSse('done', '[DONE]');
      } catch (error) {
        const safeError = error instanceof HttpError
          ? { code: error.code, message: error.message }
          : { code: 'INTERNAL_ERROR', message: 'An internal error occurred.' };
        yield encodeSse('error', safeError);
      }
    })());

    return reply.code(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no')
      .send(events);
  });

  app.post('/v1/assistant/requests', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    const body = parseOrThrow(requestSchema, request.body);
    const result = await dependencies.submit.execute(user, { text: body.input, ...(body.attachments ? { attachments: body.attachments } : {}) });
    if (result.kind === 'CHAT') return reply.code(200).send({ type: 'CHAT', result: result.result, evidence: result.evidence, ...(result.provenance ? { provenance: result.provenance } : {}) });
    return reply.code(202).send(result);
  });

  app.post('/v1/tasks/execute', async (request, reply) => {
    const user = await requireUser(request, dependencies);
    const body = parseOrThrow(taskExecutionSchema, request.body);
    if (body.attachments?.length && body.capability !== 'FILE_ANALYSIS') {
      throw new HttpError(400, 'ATTACHMENTS_ONLY_FOR_FILE_ANALYSIS', 'Uploaded files can only be attached to FILE_ANALYSIS tasks.');
    }
    const result = await dependencies.submit.submitCapability(user, body.capability, {
      text: body.prompt,
      ...(body.params ? { params: body.params } : {}),
      ...(body.attachments ? { attachments: body.attachments } : {}),
    });
    return reply.code(202).send(result);
  });

  app.get('/v1/tasks/:taskId', async (request) => {
    const user = await requireUser(request, dependencies);
    const { taskId } = request.params as { taskId: string };
    if (!idSchema.safeParse(taskId).success) throw new HttpError(400, 'INVALID_TASK_ID', 'Task id must be a UUID.');
    const task = await dependencies.tasks.findTask(taskId, user.id);
    if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    return task;
  });

  app.get('/v1/artifacts/:artifactId/content', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.taskArtifacts) throw new HttpError(501, 'ARTIFACT_STORAGE_UNAVAILABLE', 'External task artifact storage is not configured.');
    const { artifactId } = request.params as { artifactId: string };
    if (!idSchema.safeParse(artifactId).success) throw new HttpError(400, 'ARTIFACT_ID_INVALID', 'Artifact id must be a UUID.');
    const artifact = await dependencies.taskArtifacts.readForOwner(artifactId, user.id);
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="${artifact.metadata.filename}"`);
    reply.header('content-length', String(artifact.metadata.byteLength));
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', 'sandbox');
    return reply.send(artifact.body);
  });

  app.delete('/v1/artifacts/:artifactId', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const user = await requireUser(request, dependencies);
    if (!dependencies.taskArtifacts) throw new HttpError(501, 'ARTIFACT_STORAGE_UNAVAILABLE', 'External task artifact storage is not configured.');
    const { artifactId } = request.params as { artifactId: string };
    if (!idSchema.safeParse(artifactId).success) throw new HttpError(400, 'ARTIFACT_ID_INVALID', 'Artifact id must be a UUID.');
    if (!(await dependencies.taskArtifacts.deleteForOwner(artifactId, user.id))) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'The artifact was not found.');
    return reply.code(204).send();
  });

  app.post('/v1/tasks/:taskId/cancel', async (request) => {
    const user = await requireUser(request, dependencies);
    const { taskId } = request.params as { taskId: string };
    if (!idSchema.safeParse(taskId).success) throw new HttpError(400, 'INVALID_TASK_ID', 'Task id must be a UUID.');
    const result = await dependencies.tasks.cancelTask(taskId, user.id);
    if (result === 'NOT_FOUND') throw new HttpError(404, 'TASK_NOT_FOUND', 'Task was not found.');
    if (result === 'NOT_CANCELLABLE') throw new HttpError(409, 'TASK_NOT_CANCELLABLE', 'The task is already in a terminal state.');
    return { taskId, status: 'CANCELLED' as const };
  });

  app.get('/v1/tasks/:taskId/events', {
    websocket: true,
    preValidation: async (request) => {
      const { taskId } = request.params as { taskId: string };
      if (!idSchema.safeParse(taskId).success) throw new HttpError(400, 'INVALID_TASK_ID', 'Task id must be a UUID.');
      if (!dependencies.taskEvents) throw new HttpError(503, 'TASK_EVENTS_UNAVAILABLE', 'Task event streaming is unavailable.');
      const parsed = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().safeParse(request.query);
      if (!parsed.success) throw new HttpError(401, 'INVALID_WEBSOCKET_TICKET', 'A valid one-time WebSocket ticket is required.');
      const user = await dependencies.sessions.consumeWebSocketTicket(parsed.data.ticket);
      if (!user) throw new HttpError(401, 'INVALID_WEBSOCKET_TICKET', 'The WebSocket ticket is expired, consumed, or invalid.');
      const task = await dependencies.tasks.findTask(taskId, user.id);
      if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task was not found.');
      request.websocketUser = user;
      request.websocketTask = task;
    },
  }, async (socket, request) => {
    const user = request.websocketUser;
    const task = request.websocketTask;
    const source = dependencies.taskEvents;
    if (!user || !task || !source) {
      socket.close(1011, 'Task event stream unavailable');
      return;
    }

    let unsubscribe = () => {};
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe();
    };
    let snapshotSent = false;
    const pending: TaskStatusEvent[] = [];
    const sendStatus = (event: (typeof pending)[number]) => {
      if (event.taskId !== task.id || event.userId !== user.id || socket.readyState !== 1) return;
      socket.send(JSON.stringify({
        type: 'TASK_STATUS',
        taskId: event.taskId,
        status: event.status,
        changedAt: event.changedAt,
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      }));
      if (event.status === 'COMPLETED' || event.status === 'FAILED' || event.status === 'CANCELLED') socket.close(1000, 'Task finished');
    };
    unsubscribe = source.subscribe(task.id, user.id, (event) => {
      if (!snapshotSent) pending.push(event);
      else sendStatus(event);
    });
    socket.once('close', cleanup);
    socket.once('error', cleanup);
    socket.on('message', () => socket.close(1008, 'This stream is read-only'));

    try {
      // Subscribe first, then re-read state, so a transition between authorization and
      // socket setup cannot be lost. Buffer notifications until the snapshot is sent.
      const current = await dependencies.tasks.findTask(task.id, user.id);
      if (!current) {
        socket.close(1000, 'Task no longer available');
        return;
      }
      if (socket.readyState !== 1) return;
      socket.send(JSON.stringify({
        type: 'TASK_SNAPSHOT',
        taskId: current.id,
        status: current.status,
        createdAt: current.createdAt,
        startedAt: current.startedAt,
        completedAt: current.completedAt,
        ...(current.error ? { error: { code: current.error.code, message: current.error.message } } : {}),
      }));
      snapshotSent = true;
      if (current.status === 'COMPLETED' || current.status === 'FAILED' || current.status === 'CANCELLED') {
        socket.close(1000, 'Task already finished');
        return;
      }
      for (const event of pending.splice(0)) sendStatus(event);
    } catch {
      socket.close(1011, 'Unable to load task state');
    }
  });

  app.post('/v1/admin/users', async (request, reply) => {
    const admin = await requireAdmin(request, dependencies);
    const body = parseOrThrow(userSchema, request.body);
    const existing = await dependencies.auth.findUserByEmail(body.email.toLowerCase());
    if (existing) throw new HttpError(409, 'USER_ALREADY_EXISTS', 'An account with this email already exists.');
    const userId = await dependencies.auth.createUser(body.email, await hashPassword(body.password), 'USER');
    await dependencies.audit.writeAudit({ actorUserId: admin.id, action: 'USER_CREATED', resourceType: 'user', resourceId: userId, details: {} });
    return reply.code(201).send({ id: userId, email: body.email.toLowerCase(), role: 'USER' });
  });

  app.put('/v1/admin/users/:userId/capabilities/:capability', async (request, reply) => {
    const admin = await requireAdmin(request, dependencies);
    const params = request.params as { userId: string; capability: string };
    if (!idSchema.safeParse(params.userId).success) throw new HttpError(400, 'INVALID_USER_ID', 'User id must be a UUID.');
    if (!(CAPABILITIES as readonly string[]).includes(params.capability)) throw new HttpError(400, 'INVALID_CAPABILITY', 'The capability is not supported.');
    const capability = params.capability as Capability;
    if (!(await dependencies.auth.findUserById(params.userId))) throw new HttpError(404, 'USER_NOT_FOUND', 'User was not found.');
    const body = parseOrThrow(grantSchema, request.body);
    if (body.enabled) {
      await dependencies.auth.grantCapability(params.userId, capability, admin.id);
    } else {
      await dependencies.auth.revokeCapability(params.userId, capability, admin.id);
    }
    return reply.code(204).send();
  });

  app.get('/v1/admin/tools', async (request) => {
    await requireAdmin(request, dependencies);
    const tools = await Promise.all((Object.entries(TOOL_CAPABILITIES) as Array<[ToolName, Capability]>).map(async ([name, requiredCapability]) => ({
      name,
      requiredCapability,
      budget: TOOL_BUDGETS[name],
      configured: dependencies.tools ? await dependencies.tools.isToolReady(name) : false,
    })));
    return { tools };
  });

  app.get('/v1/admin/users/:userId/usage', async (request, reply) => {
    await requireAdmin(request, dependencies);
    if (!dependencies.aiUsage) throw new HttpError(501, 'AI_USAGE_UNAVAILABLE', 'Provider usage accounting is not configured.');
    const { userId } = request.params as { userId: string };
    if (!idSchema.safeParse(userId).success) throw new HttpError(400, 'INVALID_USER_ID', 'User id must be a UUID.');
    if (!(await dependencies.auth.findUserById(userId))) throw new HttpError(404, 'USER_NOT_FOUND', 'User was not found.');
    reply.header('cache-control', 'no-store');
    return dependencies.aiUsage.getUserUsageSummary(userId);
  });

  app.get('/v1/admin/users/:userId/tools', async (request) => {
    await requireAdmin(request, dependencies);
    const { userId } = request.params as { userId: string };
    if (!idSchema.safeParse(userId).success) throw new HttpError(400, 'INVALID_USER_ID', 'User id must be a UUID.');
    if (!(await dependencies.auth.findUserById(userId))) throw new HttpError(404, 'USER_NOT_FOUND', 'User was not found.');
    return { grants: await dependencies.auth.listActiveToolGrants(userId) };
  });

  app.put('/v1/admin/users/:userId/tools/:toolName', async (request, reply) => {
    const admin = await requireAdmin(request, dependencies);
    const params = request.params as { userId: string; toolName: string };
    if (!idSchema.safeParse(params.userId).success) throw new HttpError(400, 'INVALID_USER_ID', 'User id must be a UUID.');
    if (!Object.hasOwn(TOOL_CAPABILITIES, params.toolName)) throw new HttpError(400, 'INVALID_TOOL', 'The tool is not in the reviewed catalog.');
    const toolName = params.toolName as ToolName;
    const requiredCapability = TOOL_CAPABILITIES[toolName];
    if (!(await dependencies.auth.findUserById(params.userId))) throw new HttpError(404, 'USER_NOT_FOUND', 'User was not found.');
    const body = parseOrThrow(grantSchema, request.body);
    if (body.enabled) {
      if (!(await dependencies.auth.hasCapability(params.userId, requiredCapability))) {
        throw new HttpError(409, 'TOOL_REQUIRES_CAPABILITY_GRANT', 'Grant the matching capability before granting this tool.');
      }
      await dependencies.auth.grantTool(params.userId, toolName, admin.id);
    } else {
      await dependencies.auth.revokeTool(params.userId, toolName, admin.id);
    }
    return reply.code(204).send();
  });

  return app;
}
