export interface RetrievedResearchSource {
  title: string;
  url: string;
  excerpt: string;
  content: string;
}

export interface ResearchRequestReceipt {
  provider: string;
  requestId: string;
}

export interface ResearchSearchResult {
  provider: string;
  requestId: string;
  fetchedAt: string;
  rawSourceSha256: string;
  sources: RetrievedResearchSource[];
}

/** Search adapters must return source text actually retrieved by the provider, not search-result titles alone. */
export interface ResearchProvider {
  isReady(): Promise<boolean>;
  search(
    query: string,
    signal?: AbortSignal,
    onAcceptedRequest?: (receipt: ResearchRequestReceipt) => Promise<void>,
  ): Promise<ResearchSearchResult>;
}
