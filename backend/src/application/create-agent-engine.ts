import type { AgentRegistry } from '../domain/agent-registry.js';
import type { TaskRepository } from './ports.js';
import { AgentEngine } from './agent-engine.js';
import { DagExecutor } from './dag-executor.js';
import { DomainResultVerifier } from './domain-result-verifier.js';
import type { Planner, TaskGraphRepository } from './orchestration-ports.js';
import { PersistentExecutionMonitor } from './persistent-execution-monitor.js';

export function createAgentEngine(
  agents: AgentRegistry,
  tasks: TaskRepository & TaskGraphRepository,
  planner: Planner,
  graphRepository: TaskGraphRepository = tasks,
): AgentEngine {
  const monitor = new PersistentExecutionMonitor(tasks);
  const executor = new DagExecutor(agents, graphRepository, monitor);
  return new AgentEngine(planner, executor, graphRepository, monitor, new DomainResultVerifier());
}
