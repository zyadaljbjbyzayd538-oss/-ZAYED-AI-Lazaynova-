export interface MemoryEntry {
  id: string;
  ownerId: string;
  content: string;
  createdAt: string;
  expiresAt?: string;
  sensitivity: 'NORMAL' | 'SENSITIVE';
}

/** TODO: implement explicit conversation scoping, user consent, and deletion/retention handling. */
export interface ConversationMemory {
  append(conversationId: string, entry: MemoryEntry): Promise<void>;
  readRecent(conversationId: string, limit: number): Promise<MemoryEntry[]>;
  deleteConversation(conversationId: string, ownerId: string): Promise<void>;
}

/** TODO: implement bounded-TTL context, never persistent by default. */
export interface ShortTermMemory {
  put(scopeId: string, key: string, value: unknown, ttlSeconds: number): Promise<void>;
  get(scopeId: string, key: string): Promise<unknown | null>;
}

/** TODO: require explicit opt-in and implement user-visible review, export and erasure. */
export interface LongTermMemory {
  remember(ownerId: string, entry: MemoryEntry, consentId: string): Promise<void>;
  search(ownerId: string, query: string, limit: number): Promise<MemoryEntry[]>;
  erase(ownerId: string, entryId: string): Promise<void>;
}

/** TODO: isolate project-specific memory by workspace/project authorization. */
export interface ProjectMemory {
  append(projectId: string, ownerId: string, entry: MemoryEntry): Promise<void>;
  search(projectId: string, ownerId: string, query: string, limit: number): Promise<MemoryEntry[]>;
}

/** TODO: build ingestion, indexing and access-filtered retrieval for knowledge collections. */
export interface KnowledgeMemory {
  ingest(collectionId: string, ownerId: string, sourceId: string, content: string): Promise<void>;
  retrieve(collectionId: string, ownerId: string, query: string, limit: number): Promise<MemoryEntry[]>;
  removeSource(collectionId: string, ownerId: string, sourceId: string): Promise<void>;
}
