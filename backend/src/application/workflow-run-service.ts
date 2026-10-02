import { HttpError } from '../domain/errors.js';
import { TOOL_CAPABILITIES, type TaskCapability, type ToolName } from '../domain/types.js';
import { workflowRunInputSchema, toWorkflowRunView, type WorkflowApprovalDecision, type WorkflowRunInput, type WorkflowRunView } from '../domain/workflow-run.js';
import { workflowVersionInputSchema } from '../domain/workflow-definition.js';
import type { AgentRegistry } from '../domain/agent-registry.js';
import type { AuthRepository } from './ports.js';
import type { FileService } from './file-ports.js';
import type { ToolManager } from './orchestration-ports.js';
import type { WorkflowDefinitionService } from './workflow-definition-service.js';
import type { WorkflowRunRepository, ApprovalResult, WorkflowCancelResult } from './workflow-run-ports.js';

/** Owner-scoped workflow acceptance, authorization preflight, approval, and cancellation boundary. */
export class WorkflowRunService {
  constructor(
    private readonly definitions: WorkflowDefinitionService,
    private readonly runs: WorkflowRunRepository,
    private readonly auth: Pick<AuthRepository, 'hasCapability' | 'hasToolGrant'>,
    private readonly agents: AgentRegistry,
    private readonly tools?: Pick<ToolManager, 'isToolReady'>,
    private readonly files?: Pick<FileService, 'getMetadata'>,
  ) {}

  async start(ownerId: string, workflowId: string, rawInput: unknown): Promise<WorkflowRunView> {
    const parsed = workflowRunInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new HttpError(400, 'INVALID_WORKFLOW_RUN', 'The workflow run request is invalid.');
    const input: WorkflowRunInput = parsed.data;
    const definition = input.version === undefined
      ? await this.definitions.getLatest(ownerId, workflowId)
      : await this.definitions.getVersion(ownerId, workflowId, input.version);
    const validatedDefinition = workflowVersionInputSchema.safeParse({ steps: definition.steps });
    if (!validatedDefinition.success) throw new HttpError(503, 'WORKFLOW_DEFINITION_INVALID', 'The stored workflow definition is invalid.');
    const steps = validatedDefinition.data.steps;
    const capabilities = [...new Set(steps.map((step) => step.capability))];
    const needsFile = capabilities.includes('FILE_ANALYSIS');
    if (needsFile && input.attachments?.length !== 1) {
      throw new HttpError(400, 'WORKFLOW_FILE_REQUIRED', 'This workflow requires exactly one owner-uploaded file.');
    }
    if (!needsFile && input.attachments?.length) {
      throw new HttpError(400, 'WORKFLOW_FILE_NOT_ALLOWED', 'This workflow does not contain a file-analysis step.');
    }
    const taskInput = { text: input.prompt, attachments: input.attachments ?? [] };
    for (const capability of capabilities) await this.preflightCapability(ownerId, capability, taskInput.attachments[0]);

    const run = await this.runs.createWorkflowRun({
      ownerId,
      workflowId: definition.workflowId,
      workflowName: definition.name,
      version: definition.version,
      input: taskInput,
      steps,
    });
    return toWorkflowRunView(run);
  }

  async get(ownerId: string, runId: string): Promise<WorkflowRunView> {
    const run = await this.runs.findWorkflowRun(runId, ownerId);
    if (!run) throw new HttpError(404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run was not found.');
    return toWorkflowRunView(run);
  }

  async decide(ownerId: string, runId: string, stepId: string, decision: WorkflowApprovalDecision): Promise<WorkflowRunView> {
    const result: ApprovalResult = await this.runs.decideWorkflowApproval(ownerId, runId, stepId, decision);
    if (result === 'NOT_FOUND') throw new HttpError(404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run was not found.');
    if (result === 'NOT_WAITING') throw new HttpError(409, 'WORKFLOW_APPROVAL_NOT_PENDING', 'This step is not waiting for owner approval.');
    return this.get(ownerId, runId);
  }

  async cancel(ownerId: string, runId: string): Promise<WorkflowRunView> {
    const result: WorkflowCancelResult = await this.runs.cancelWorkflowRun(ownerId, runId);
    if (result === 'NOT_FOUND') throw new HttpError(404, 'WORKFLOW_RUN_NOT_FOUND', 'Workflow run was not found.');
    if (result === 'NOT_CANCELLABLE') throw new HttpError(409, 'WORKFLOW_RUN_NOT_CANCELLABLE', 'This workflow run is already terminal.');
    return this.get(ownerId, runId);
  }

  private async preflightCapability(ownerId: string, capability: TaskCapability, fileId?: string): Promise<void> {
    if (!(await this.auth.hasCapability(ownerId, capability))) {
      throw new HttpError(403, 'CAPABILITY_PERMISSION_REQUIRED', 'The account is not granted a capability required by this workflow.');
    }
    const requiredTools = (Object.entries(TOOL_CAPABILITIES) as Array<[ToolName, TaskCapability]>)
      .filter(([, required]) => required === capability);
    for (const [toolName] of requiredTools) {
      if (!(await this.auth.hasToolGrant(ownerId, toolName))) {
        throw new HttpError(403, 'TOOL_PERMISSION_DENIED', 'The account is not granted a tool required by this workflow.');
      }
    }
    await this.agents.requireReady(capability);
    for (const [toolName] of requiredTools) {
      if (!this.tools || !(await this.tools.isToolReady(toolName))) {
        throw new HttpError(501, 'CAPABILITY_UNAVAILABLE', 'A required workflow tool is not configured.');
      }
    }
    if (capability === 'FILE_ANALYSIS') {
      if (!fileId || !this.files) throw new HttpError(501, 'FILE_SERVICE_UNAVAILABLE', 'Encrypted file storage is unavailable.');
      await this.files.getMetadata({ userId: ownerId, fileId });
    }
  }
}
