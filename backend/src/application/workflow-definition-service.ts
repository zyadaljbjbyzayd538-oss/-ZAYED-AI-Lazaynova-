import {
  workflowDefinitionInputSchema,
  workflowVersionInputSchema,
  type WorkflowDefinitionInput,
  type WorkflowDefinitionSummary,
  type WorkflowDefinitionVersion,
  type WorkflowVersionInput,
} from '../domain/workflow-definition.js';
import { HttpError } from '../domain/errors.js';
import type { WorkflowDefinitionRepository } from './workflow-definition-ports.js';

/** Validates and stores versioned definitions; it does not execute workflow steps. */
export class WorkflowDefinitionService {
  constructor(private readonly repository: WorkflowDefinitionRepository) {}

  async create(ownerId: string, rawDefinition: unknown): Promise<WorkflowDefinitionVersion> {
    const parsed = workflowDefinitionInputSchema.safeParse(rawDefinition);
    if (!parsed.success) throw new HttpError(400, 'INVALID_WORKFLOW_DEFINITION', 'The workflow definition is invalid.');
    return this.repository.createWorkflowDefinition(ownerId, parsed.data satisfies WorkflowDefinitionInput);
  }

  async addVersion(ownerId: string, workflowId: string, rawDefinition: unknown): Promise<WorkflowDefinitionVersion> {
    const parsed = workflowVersionInputSchema.safeParse(rawDefinition);
    if (!parsed.success) throw new HttpError(400, 'INVALID_WORKFLOW_DEFINITION', 'The workflow definition is invalid.');
    const version = await this.repository.createWorkflowDefinitionVersion(ownerId, workflowId, parsed.data satisfies WorkflowVersionInput);
    if (!version) throw new HttpError(404, 'WORKFLOW_NOT_FOUND', 'Workflow was not found.');
    return version;
  }

  async list(ownerId: string): Promise<WorkflowDefinitionSummary[]> {
    return this.repository.listWorkflowDefinitions(ownerId);
  }

  async getLatest(ownerId: string, workflowId: string): Promise<WorkflowDefinitionVersion> {
    const definition = await this.repository.findLatestWorkflowDefinition(ownerId, workflowId);
    if (!definition) throw new HttpError(404, 'WORKFLOW_NOT_FOUND', 'Workflow was not found.');
    return definition;
  }

  async getVersion(ownerId: string, workflowId: string, version: number): Promise<WorkflowDefinitionVersion> {
    const definition = await this.repository.findWorkflowDefinitionVersion(ownerId, workflowId, version);
    if (!definition) throw new HttpError(404, 'WORKFLOW_NOT_FOUND', 'Workflow was not found.');
    return definition;
  }
}
