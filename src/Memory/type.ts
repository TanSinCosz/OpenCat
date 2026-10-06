export interface MultiModalMessages {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface Message {
  role: string;
  content: string | MultiModalMessages;
}

export interface EmbeddingConfig {
  apiKey?: string;
  model?: string | any;
  baseURL?: string;
  url?: string;
  embeddingDims?: number;
  modelProperties?: Record<string, any>;
}

export interface VectorStoreConfig {
  collectionName?: string;
  dimension?: number;
  dbPath?: string;
  client?: any;
  instance?: any;
  [key: string]: any;
}

export interface LLMConfig {
  provider?: string;
  baseURL?: string;
  url?: string;
  config?: Record<string, any>;
  apiKey?: string;
  model?: string | any;
  modelProperties?: Record<string, any>;
  timeout?: number;
}

export interface SearchMemoryOptions {
  topK?: number;
  filters?: SearchFilters;
  threshold?: number;
  explain?: boolean;
}

export interface MemoryConfig {
  version?: string;
  embedder: {
    provider: string;
    config: EmbeddingConfig;
  };
  vectorStore: {
    provider: string;
    config: VectorStoreConfig;
  };
  llm: {
    provider: string;
    config: LLMConfig;
  };
  customInstructions?: string;
}

export interface MemoryItem {
  id: string;
  memory: string;
  hash?: string;
  createdAt?: string;
  updatedAt?: string;
  score?: number;
  metadata?: Record<string, any>;
}

export interface SearchFilters {
  user_id?: string;
  agent_id?: string;
  run_id?: string;
  [key: string]: any;
}

export interface SearchResult {
  results: MemoryItem[];
}

export interface VectorStoreResult {
  id: string;
  payload: Record<string, any>;
  score?: number;
}

export interface Entity {
  userId?: string;
  agentId?: string;
  runId?: string;
}

export interface AddMemoryOptions extends Entity {
  metadata?: Record<string, any>;
  filters?: SearchFilters;
  infer?: boolean;
  /**
   * Explicit prior messages supplied by the host runtime for reference
   * resolution. MemoryTool does not read chat history from its own database.
   */
  contextMessages?: Message[];
  observationDate?: string;
  currentDate?: string;
  customInstructions?: string;
}
