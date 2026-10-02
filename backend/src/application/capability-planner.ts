import type { AgentExecutionContext, TaskCapability } from '../domain/types.js';
import type { AgentPlan } from '../domain/task-graph.js';
import type { Planner } from './orchestration-ports.js';

/** Safe offline planner: maps one authorized capability to one concrete registered driver action. */
export class CapabilityPlanner implements Planner {
  async isReady(): Promise<boolean> {
    return true;
  }

  async plan(context: AgentExecutionContext): Promise<AgentPlan> {
    const capability = context.capability as TaskCapability;
    return {
      graph: {
        version: 1,
        rootCapability: capability,
        nodes: [{
          id: `run-${capability.toLowerCase()}`,
          capability,
          operation: 'RUN_CAPABILITY',
          goal: '',
          dependsOn: [],
        }],
      },
      plannerEvidence: [],
      plannerProvenance: { planner: 'deterministic-capability-planner', version: 1 },
    };
  }
}
