import type {
  WorkflowDefinitionInput,
  WorkflowDefinitionSummary,
  WorkflowDefinitionVersion,
  WorkflowVersionInput,
} from '../domain/workflow-definition.js';

/** Owner-scoped immutable workflow-definition versions; execution is deliberately a separate capability. */
export interface WorkflowDefinitionRepository {
  createWorkflowDefinition(ownerId: string, definition: WorkflowDefinitionInput): Promise<WorkflowDefinitionVersion>;
  createWorkflowDefinitionVersion(ownerId: string, workflowId: string, definition: WorkflowVersionInput): Promise<WorkflowDefinitionVersion | null>;
  listWorkflowDefinitions(ownerId: string): Promise<WorkflowDefinitionSummary[]>;
  findWorkflowDefinitionVersion(ownerId: string, workflowId: string, version: number): Promise<WorkflowDefinitionVersion | null>;
  findLatestWorkflowDefinition(ownerId: string, workflowId: string): Promise<WorkflowDefinitionVersion | null>;
}
