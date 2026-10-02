import { createHash } from 'node:crypto';
import { CAPABILITIES, type EvidenceItem, type TaskCapability } from './types.js';

export const TASK_GRAPH_OPERATIONS = ['RUN_CAPABILITY'] as const;
export type TaskGraphOperation = typeof TASK_GRAPH_OPERATIONS[number];
export type GraphNodeStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

const TASK_CAPABILITY_SET = new Set<string>(CAPABILITIES.filter((capability) => capability !== 'CHAT'));

export interface TaskGraphNode {
  id: string;
  capability: TaskCapability;
  operation: TaskGraphOperation;
  goal: string;
  dependsOn: string[];
}

export interface TaskGraph {
  version: 1;
  rootCapability: TaskCapability;
  nodes: TaskGraphNode[];
}

export interface AgentPlan {
  graph: TaskGraph;
  plannerEvidence: EvidenceItem[];
  plannerProvenance: Record<string, unknown> | null;
}

export interface PersistedGraphNode {
  id: string;
  status: GraphNodeStatus;
  attempts: number;
  result: unknown | null;
}

export interface TaskGraphSnapshot {
  plan: AgentPlan;
  planHash: string;
  nodes: PersistedGraphNode[];
}

export class InvalidTaskGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTaskGraphError';
  }
}

export function validateTaskGraph(graph: TaskGraph, expectedCapability: TaskCapability): TaskGraphNode[] {
  if (!TASK_CAPABILITY_SET.has(expectedCapability) || !graph || graph.version !== 1 || graph.rootCapability !== expectedCapability || !Array.isArray(graph.nodes)) {
    throw new InvalidTaskGraphError('The execution plan has an invalid version or capability.');
  }
  if (graph.nodes.length < 1 || graph.nodes.length > 6) {
    throw new InvalidTaskGraphError('An execution plan must contain between one and six nodes.');
  }

  const nodes = new Map<string, TaskGraphNode>();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(node.id)) {
      throw new InvalidTaskGraphError('The execution plan contains an invalid node id.');
    }
    if (nodes.has(node.id)) throw new InvalidTaskGraphError('The execution plan contains duplicate node ids.');
    if (node.capability !== expectedCapability || node.operation !== 'RUN_CAPABILITY') {
      throw new InvalidTaskGraphError('A node requested an unapproved capability or operation.');
    }
    if (typeof node.goal !== 'string' || node.goal.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(node.goal)) {
      throw new InvalidTaskGraphError('A node goal is invalid or too long.');
    }
    if (!Array.isArray(node.dependsOn) || node.dependsOn.length > 6 || node.dependsOn.some((id) => typeof id !== 'string')) {
      throw new InvalidTaskGraphError('A node has invalid dependencies.');
    }
    nodes.set(node.id, node);
  }

  for (const node of nodes.values()) {
    const dependencies = new Set(node.dependsOn);
    if (dependencies.size !== node.dependsOn.length || dependencies.has(node.id)) {
      throw new InvalidTaskGraphError('A node has duplicate or self dependencies.');
    }
    for (const dependency of dependencies) {
      if (!nodes.has(dependency)) throw new InvalidTaskGraphError('A node references an unknown dependency.');
    }
  }

  const nonTerminalIds = new Set([...nodes.values()].flatMap((node) => node.dependsOn));
  const terminalNodes = [...nodes.keys()].filter((id) => !nonTerminalIds.has(id));
  if (terminalNodes.length !== 1) throw new InvalidTaskGraphError('An execution plan must converge to exactly one final node.');

  const remaining = new Map([...nodes].map(([id, node]) => [id, new Set(node.dependsOn)]));
  const ordered: TaskGraphNode[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.keys()].filter((id) => remaining.get(id)?.size === 0);
    if (ready.length === 0) throw new InvalidTaskGraphError('The execution plan contains a dependency cycle.');
    for (const id of ready) {
      ordered.push(nodes.get(id)!);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return ordered;
}

export function hashTaskGraph(graph: TaskGraph): string {
  return createHash('sha256').update(canonicalJson(graph)).digest('hex');
}

export function hashAgentPlan(plan: AgentPlan): string {
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
