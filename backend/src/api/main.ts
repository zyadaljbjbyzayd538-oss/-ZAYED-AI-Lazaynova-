import { Queue } from 'bullmq';
import { buildApp } from './app.js';
import { SubmitAssistantRequest } from '../application/submit-request.js';
import { SessionService } from '../auth/session-service.js';
import { buildAgentRegistryFromEnvironment, buildAiModelCatalogFromEnvironment, buildTaskPlannerFromEnvironment } from '../infrastructure/agent-composition.js';
import { buildCoreToolManagerFromEnvironment } from '../infrastructure/core-tools.js';
import { loadConfig } from '../infrastructure/config.js';
import { redisConnectionFromUrl } from '../infrastructure/redis.js';
import { createPool, PostgresRepositories } from '../infrastructure/postgres.js';
import { PostgresTaskEventSource } from '../infrastructure/postgres-task-events.js';
import { PostgresWorkflowDefinitionRepository } from '../infrastructure/postgres-workflow-definitions.js';
import { WorkflowDefinitionService } from '../application/workflow-definition-service.js';
import { WorkflowRunService } from '../application/workflow-run-service.js';
import { PostgresWorkflowRunRepository } from '../infrastructure/postgres-workflow-runs.js';
import { EncryptedTextFileService } from '../infrastructure/encrypted-text-file-service.js';
import { loadModelPricingSchedule } from '../infrastructure/provider-usage-accounting.js';
import { PostgresAiUsageLedger } from '../infrastructure/postgres-ai-usage-ledger.js';
import { buildTaskArtifactServiceFromEnvironment } from '../infrastructure/artifact-composition.js';
import { TASK_QUEUE_NAME, type TaskJob } from '../infrastructure/outbox-dispatcher.js';
import { WORKFLOW_RUN_QUEUE_NAME, type WorkflowRunJob } from '../infrastructure/workflow-run-outbox.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const repositories = new PostgresRepositories(pool);
const taskArtifacts = buildTaskArtifactServiceFromEnvironment(process.env, pool);
const aiUsage = new PostgresAiUsageLedger(pool, loadModelPricingSchedule(process.env.AI_MODEL_PRICING_JSON));
const workflows = new WorkflowDefinitionService(new PostgresWorkflowDefinitionRepository(pool));
const taskEvents = new PostgresTaskEventSource(pool);
await taskEvents.start();
const files = new EncryptedTextFileService(repositories, config.FILE_ENCRYPTION_KEY);
const tools = buildCoreToolManagerFromEnvironment(process.env, repositories, repositories, files, aiUsage);
const agents = buildAgentRegistryFromEnvironment(process.env, undefined, undefined, files, tools, aiUsage); // Usage is attributed from trusted worker context, never request fields.
const workflowRuns = new WorkflowRunService(workflows, new PostgresWorkflowRunRepository(pool), repositories, agents, tools, files);
const aiModelCatalog = buildAiModelCatalogFromEnvironment();
const planner = buildTaskPlannerFromEnvironment(process.env, undefined, aiUsage);
const sessions = new SessionService(repositories, repositories, config.SESSION_TTL_HOURS);
const redisConnection = redisConnectionFromUrl(config.REDIS_URL);
const queue = new Queue<TaskJob>(TASK_QUEUE_NAME, { connection: redisConnection });
const workflowQueue = new Queue<WorkflowRunJob>(WORKFLOW_RUN_QUEUE_NAME, { connection: redisConnection });

const app = await buildApp({
  sessions,
  auth: repositories,
  tasks: repositories,
  audit: repositories,
  submit: new SubmitAssistantRequest(repositories, repositories, agents, files, planner),
  agents,
  planner,
  tools,
  files,
  workflows,
  workflowRuns,
  aiModelCatalog,
  taskEvents,
  aiUsage,
  ...(taskArtifacts ? { taskArtifacts } : {}),
  rateLimit: { max: config.RATE_LIMIT_MAX, timeWindow: config.RATE_LIMIT_WINDOW },
});

app.get('/ready', async (_request, reply) => {
  let database: 'ok' | 'error' = 'error';
  let queueStatus: 'ok' | 'error' = 'error';
  let workflowQueueStatus: 'ok' | 'error' = 'error';
  let artifactStore: 'ok' | 'error' | 'not_configured' = taskArtifacts ? 'error' : 'not_configured';
  try { await pool.query('SELECT 1'); database = 'ok'; } catch { /* reported in response */ }
  try { await queue.waitUntilReady(); queueStatus = 'ok'; } catch { /* reported in response */ }
  try { await workflowQueue.waitUntilReady(); workflowQueueStatus = 'ok'; } catch { /* reported in response */ }
  if (taskArtifacts) {
    try { artifactStore = await taskArtifacts.isReady() ? 'ok' : 'error'; } catch { artifactStore = 'error'; }
  }
  const eventStream: 'ok' | 'error' = taskEvents.connected ? 'ok' : 'error';
  const ready = database === 'ok' && queueStatus === 'ok' && workflowQueueStatus === 'ok' && eventStream === 'ok' && artifactStore !== 'error';
  return reply.code(ready ? 200 : 503).send({
    status: ready ? 'ready' : 'not_ready',
    database,
    queue: queueStatus,
    workflowQueue: workflowQueueStatus,
    eventStream,
    artifactStore,
    registeredDrivers: agents.registeredCount(),
  });
});

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(`Lazaynova API listening on ${config.HOST}:${config.PORT}`);

const shutdown = async () => {
  await app.close();
  await taskEvents.close();
  await Promise.all([queue.close(), workflowQueue.close()]);
  taskArtifacts?.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
