import { createHash, timingSafeEqual } from 'node:crypto';
import type { EvidenceItem } from './types.js';

export interface ChainedEvidence extends EvidenceItem {
  chain: {
    sequence: number;
    previousHash: string;
    itemHash: string;
    chainHash: string;
  };
}

export interface EvidenceChainResult {
  evidence: EvidenceItem[];
  rootHash: string;
  itemCount: number;
}

const EMPTY_ROOT = createHash('sha256').update('lazaynova-evidence-chain-v1').digest('hex');
const MARKER_KIND = 'evidence_chain';

export function buildEvidenceChain(items: EvidenceItem[]): EvidenceChainResult {
  let previousHash = EMPTY_ROOT;
  const sealed: ChainedEvidence[] = items.map((item, index) => {
    const base = withoutChain(item);
    const itemHash = sha256(canonicalJson(base));
    const chainHash = sha256(`${previousHash}:${index + 1}:${itemHash}`);
    const chained = {
      ...base,
      chain: { sequence: index + 1, previousHash, itemHash, chainHash },
    } as ChainedEvidence;
    previousHash = chainHash;
    return chained;
  });
  const rootHash = previousHash;
  const marker: EvidenceItem = { kind: MARKER_KIND, rootHash, itemCount: sealed.length };
  return { evidence: [...sealed, marker], rootHash, itemCount: sealed.length };
}

export function verifyEvidenceChain(evidence: EvidenceItem[]): boolean {
  if (!Array.isArray(evidence) || evidence.length === 0) return false;
  const marker = evidence[evidence.length - 1] as EvidenceItem & { rootHash?: unknown; itemCount?: unknown };
  if (marker.kind !== MARKER_KIND || typeof marker.rootHash !== 'string' || !Number.isInteger(marker.itemCount)) return false;
  const entries = evidence.slice(0, -1) as ChainedEvidence[];
  if (marker.itemCount !== entries.length) return false;

  let previousHash = EMPTY_ROOT;
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];
    if (!item || !item.chain || item.chain.sequence !== index + 1 || item.chain.previousHash !== previousHash) return false;
    const itemHash = sha256(canonicalJson(withoutChain(item)));
    const chainHash = sha256(`${previousHash}:${index + 1}:${itemHash}`);
    if (!constantTimeEqual(itemHash, item.chain.itemHash) || !constantTimeEqual(chainHash, item.chain.chainHash)) return false;
    previousHash = chainHash;
  }
  return constantTimeEqual(previousHash, marker.rootHash);
}

function withoutChain(item: EvidenceItem): Record<string, unknown> {
  const { chain: _chain, ...base } = item as EvidenceItem & { chain?: unknown };
  return base;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
