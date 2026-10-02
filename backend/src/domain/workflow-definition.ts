import { z } from 'zod';

/** Only task capabilities with a real driver implementation may be named in workflow definitions. */
export const WORKFLOW_STEP_CAPABILITIES = ['WRITING', 'WEB_RESEARCH', 'FILE_ANALYSIS', 'MODEL_ANALYSIS'] as const;

const stepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const workflowNameSchema = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);

export const workflowStepSchema = z.object({
  id: stepIdSchema,
  capability: z.enum(WORKFLOW_STEP_CAPABILITIES),
  prompt: z.string().trim().min(1).max(20_000),
  dependsOn: z.array(stepIdSchema).max(12).refine((items) => new Set(items).size === items.length, 'Dependencies must be unique.'),
  /** Metadata for the future runner; approval is not executed until workflow runs exist. */
  approvalRequired: z.boolean(),
}).strict();

const workflowStepsSchema = z.array(workflowStepSchema).min(1).max(12).superRefine((steps, context) => {
  const indices = new Map<string, number>();
  steps.forEach((step, index) => {
    const previous = indices.get(step.id);
    if (previous !== undefined) {
      context.addIssue({ code: 'custom', path: [index, 'id'], message: `Duplicate step id; first declared at index ${previous}.` });
    } else {
      indices.set(step.id, index);
    }
  });

  steps.forEach((step, index) => {
    step.dependsOn.forEach((dependency) => {
      if (!indices.has(dependency)) {
        context.addIssue({ code: 'custom', path: [index, 'dependsOn'], message: `Unknown dependency: ${dependency}.` });
      } else if (dependency === step.id) {
        context.addIssue({ code: 'custom', path: [index, 'dependsOn'], message: 'A step cannot depend on itself.' });
      }
    });
  });

  if (indices.size !== steps.length) return;
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  let completed = 0;
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, dependencies]) =>
      [...dependencies].every((dependency) => !remaining.has(dependency)));
    if (ready.length === 0) {
      context.addIssue({ code: 'custom', path: [], message: 'Workflow steps contain a dependency cycle.' });
      return;
    }
    for (const [id] of ready) {
      remaining.delete(id);
      completed += 1;
    }
  }
  if (completed !== steps.length) context.addIssue({ code: 'custom', path: [], message: 'Workflow dependency validation failed.' });
});

export const workflowDefinitionInputSchema = z.object({
  name: workflowNameSchema,
  steps: workflowStepsSchema,
}).strict();

export const workflowVersionInputSchema = z.object({
  steps: workflowStepsSchema,
}).strict();

export type WorkflowStepCapability = (typeof WORKFLOW_STEP_CAPABILITIES)[number];
export type WorkflowStepDefinition = z.infer<typeof workflowStepSchema>;
export type WorkflowDefinitionInput = z.infer<typeof workflowDefinitionInputSchema>;
export type WorkflowVersionInput = z.infer<typeof workflowVersionInputSchema>;

export interface WorkflowDefinitionVersion extends WorkflowDefinitionInput {
  workflowId: string;
  version: number;
  createdAt: string;
}

export interface WorkflowDefinitionSummary {
  workflowId: string;
  name: string;
  latestVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** Stable topological order for consumers; this validates independently of HTTP parsing. */
export function orderWorkflowSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  const validated = workflowStepsSchema.safeParse(steps);
  if (!validated.success) throw new Error('Workflow steps failed validation.');
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn)]));
  const ordered: WorkflowStepDefinition[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((id) => [...remaining.get(id)!].every((dependency) => !remaining.has(dependency)));
    if (ready.length === 0) throw new Error('Workflow steps contain a dependency cycle.');
    for (const id of ready) {
      ordered.push(steps.find((step) => step.id === id)!);
      remaining.delete(id);
    }
  }
  return ordered;
}
