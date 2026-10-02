import { Queue, Worker } from 'bullmq';
import { ProcessTask } from '../application/process-task.js';
import { buildAgentRegistryFromEnvironment, buildTaskPlannerFromEnvironment } from '../infrastructure/agent-composition.js';
import { loadConfig } from '../infrastructure/config.js';
import { createPool, PostgresRepositories } from '../infrastructure/postgres.js';
import { redisConnectionFromUrl } from '../infrastructure/redis.js';
import { OutboxDispatcher, TASK_QUEUE_NAME, type TaskJob } from '../infrastructure/outbox-dispatcher.js';
import { EncryptedTextFileService } from '../infrastructure/encrypted-text-file-service.js';
import { buildCoreToolManagerFromEnvironment } from '../infrastructure/core-tools.js';
import { createAgentEngine } from '../application/create-agent-engine.js';
import { HttpError } from '../domain/errors.js';
import { PostgresTaskEventSource } from '../infrastructure/postgres-task-events.js';
import { ProcessWorkflowRun } from '../application/process-workflow-run.js';
import { PostgresWorkflowRunRepository } from '../infrastructure/postgres-workflow-runs.js';
import { loadModelPricingSchedule } from '../infrastructure/provider-usage-accounting.js';
import { PostgresAiUsageLedger } from '../infrastructure/postgres-ai-usage-ledger.js';
import { buildTaskArtifactServiceFromEnvironment } from '../infrastructure/artifact-composition.js';
import { ExternalizingTaskGraphRepository } from '../infrastructure/externalizing-task-graph-repository.js';
import { WorkflowRunOutboxDispatcher, WORKFLOW_RUN_QUEUE_NAME, type WorkflowRunJob } from '../infrastructure/workflow-run-outbox.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const repositories = new PostgresRepositories(pool);
const taskArtifacts = buildTaskArtifactServiceFromEnvironment(process.env, pool);
const aiUsage = new PostgresAiUsageLedger(pool, loadModelPricingSchedule(process.env.AI_MODEL_PRICING_JSON));
const cancellationEvents = new PostgresTaskEventSource(pool);
await cancellationEvents.start();
const files = new EncryptedTextFileService(repositories, config.FILE_ENCRYPTION_KEY);
const tools = buildCoreToolManagerFromEnvironment(process.env, repositories, repositories, files, aiUsage);
const agents = buildAgentRegistryFromEnvironment(process.env, undefined, undefined, files, tools, aiUsage); // Same provider accounting and routing as the API.
const planner = buildTaskPlannerFromEnvironment(process.env, undefined, aiUsage);
const graphRepository = taskArtifacts
  ? new ExternalizingTaskGraphRepository(repositories, taskArtifacts, async (taskId) => (await repositories.findTaskForWorker(taskId))?.userId ?? null)
  : repositories;
const engine = createAgentEngine(agents, repositories, planner, graphRepository);
const processor = new ProcessTask(repositories, repositories, repositories, agents, engine, cancellationEvents, taskArtifacts);
const connection = redisConnectionFromUrl(config.REDIS_URL);
const queue = new Queue<TaskJob>(TASK_QUEUE_NAME, { connection });
const worker = new Worker<TaskJob>(TASK_QUEUE_NAME, async (job) => processor.execute(job.data.taskId), { connection, concurrency: 4 });
const dispatcher = new OutboxDispatcher(pool, queue);
const workflowRunRepository = new PostgresWorkflowRunRepository(pool);
const workflowProcessor = new ProcessWorkflowRun(repositories, workflowRunRepository, agents, files);
const workflowQueue = new Queue<WorkflowRunJob>(WORKFLOW_RUN_QUEUE_NAME, { connection });
const workflowWorker = new Worker<WorkflowRunJob>(WORKFLOW_RUN_QUEUE_NAME, async (job) => {
  const workflowRunId = job.data?.workflowRunId;
  if (typeof workflowRunId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflowRunId)) return;
  await workflowProcessor.execute(workflowRunId);
}, { connection, concurrency: 2 });
const workflowDispatcher = new WorkflowRunOutboxDispatcher(pool, workflowQueue);

worker.on('failed', (job, error) => console.error('Queue job failed after retries:', job?.id, error instanceof HttpError ? error.code : 'WORKER_INTERNAL_ERROR'));
worker.on('error', (error) => console.error('Worker error:', error instanceof HttpError ? error.code : 'WORKER_INTERNAL_ERROR'));
workflowWorker.on('failed', (job, error) => console.error('Workflow queue job failed:', job?.id, error instanceof HttpError ? error.code : 'WORKFLOW_WORKER_INTERNAL_ERROR'));
workflowWorker.on('error', (error) => console.error('Workflow worker error:', error instanceof HttpError ? error.code : 'WORKFLOW_WORKER_INTERNAL_ERROR'));
void dispatcher.run();
void workflowDispatcher.run();
console.info(`Lazaynova task and workflow workers started; registered drivers: ${agents.registeredCount()}.`);

const shutdown = async () => {
  dispatcher.stop();
  workflowDispatcher.stop();
  await Promise.all([worker.close(), workflowWorker.close()]);
  await Promise.all([queue.close(), workflowQueue.close()]);
  await cancellationEvents.close();
  taskArtifacts?.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
