import { VectorStore } from "./base.js";
import Database from "better-sqlite3";
import { VectorStoreConfig , VectorStoreResult, SearchFilters, } from "../type.js";
import path from "path";
import os from "os";
import fs from "fs";


// 返回默认数据库路径。
// 现在默认放在用户目录下的 .mem0/vector_store.db。
// 作用是：如果外部没传 dbPath，就用这个默认位置。
export function getDefaultVectorStoreDbPath(): string {
  return path.join(os.homedir(), ".mem0", "vector_store.db");
}

// 确保 SQLite 文件所在目录存在。
// 如果是 :memory: 或 file: 这类特殊路径，就不处理。
// 作用是：避免 new Database(dbPath) 时因为目录不存在而失败。
export function ensureSQLiteDirectory(dbPath: string): void {
  if (!dbPath || dbPath === ":memory:" || dbPath.startsWith("file:")) {
    return;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}



interface MemoryVector {
  id: string;
  vector: number[];
  payload: Record<string, any>;
}


export class MemoryVectorStore implements VectorStore {
  private db: Database.Database;
  private dimension: number;
  private dbPath: string;
  

  private static readonly CAMEL_TO_SNAKE: Record<string, string> = {
    userId: "user_id",
    agentId: "agent_id",
    runId: "run_id",
  };
// 把 payload 里的驼峰字段改成下划线字段。
  private normalizePayload(payload: Record<string, any>): Record<string, any> {
    for (const [camel, snake] of Object.entries(
      MemoryVectorStore.CAMEL_TO_SNAKE,
    )) {
      if (camel in payload && !(snake in payload)) {
        payload[snake] = payload[camel];
        delete payload[camel];
      }
    }
    return payload;
  }
  //   初始化整个向量库实例。
  // 主要做几件事：
  // 读取维度 dimension
  // 确定数据库路径 dbPath
  // 如果没显式传路径，就提示默认路径变化
  // 创建目录
  // 打开 SQLite
  // 调 init()
  // 作用是：把数据库连接和运行参数准备好。
  constructor(config: VectorStoreConfig) {
    this.dimension = config.dimension || 1536; // Default OpenAI dimension
    this.dbPath = config.dbPath || getDefaultVectorStoreDbPath();

    if (!config.dbPath) {
      const oldDefault = path.join(process.cwd(), "vector_store.db");
      if (fs.existsSync(oldDefault) && oldDefault !== this.dbPath) {
        console.warn(
          `[mem0] Default vector_store.db location changed from ${oldDefault} to ${this.dbPath}. ` +
            `Move your existing file or set vectorStore.config.dbPath explicitly.`,
        );
      }
    }

    ensureSQLiteDirectory(this.dbPath);
    this.db = new Database(this.dbPath);
    this.init();
  }
  // 初始化数据库表。
  // 创建：
  // vectors
  // memory_migrations
  // 作用是：首次启动时自动建表，避免后续 SQL 失败。

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY,
        vector BLOB NOT NULL,
        payload TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE
      )
    `);
  }
  // 计算两个向量的余弦相似度。
  private cosineSimilarity(a: number[], b: number[]): number { 
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 判断 payload 的某个字段是否满足过滤条件。
   * Supports comparison operators: eq, ne, gt, gte, lt, lte, in, nin, contains, icontains
   */
  private matchFieldCondition(
    payload: Record<string, any>,
    key: string,
    value: any,
  ): boolean {
    const payloadValue = payload[key];

    // Handle non-dict values
    if (typeof value !== "object" || value === null) {
      // Wildcard: match any value
      if (value === "*") {
        return true;
      }
      // Simple equality
      return payloadValue === value;
    }

    // Handle array shorthand: {"field": ["a", "b"]} treated as "in" operator
    if (Array.isArray(value)) {
      return value.includes(payloadValue);
    }

    // Handle comparison operators
    if ("eq" in value) {
      return payloadValue === value.eq;
    }
    if ("ne" in value) {
      return payloadValue !== value.ne;
    }
    if ("gt" in value) {
      return payloadValue > value.gt;
    }
    if ("gte" in value) {
      return payloadValue >= value.gte;
    }
    if ("lt" in value) {
      return payloadValue < value.lt;
    }
    if ("lte" in value) {
      return payloadValue <= value.lte;
    }
    if ("in" in value) {
      return Array.isArray(value.in) && value.in.includes(payloadValue);
    }
    if ("nin" in value) {
      return !Array.isArray(value.nin) || !value.nin.includes(payloadValue);
    }
    if ("contains" in value) {
      return (
        typeof payloadValue === "string" &&
        payloadValue.includes(value.contains)
      );
    }
    if ("icontains" in value) {
      return (
        typeof payloadValue === "string" &&
        payloadValue.toLowerCase().includes(value.icontains.toLowerCase())
      );
    }

    // Unknown operator - treat as nested object for equality (shouldn't happen normally)
    return payloadValue === value;
  }

  /**
   * 判断一条向量记录是否满足整组 filters。
   * Supports logical operators (AND, OR, NOT) and comparison operators.
   */
  private filterVector(vector: MemoryVector, filters?: SearchFilters): boolean {
    if (!filters || Object.keys(filters).length === 0) return true;

    // Normalize $or/$not/$and → OR/NOT/AND
    const keyMap: Record<string, string> = {
      $and: "AND",
      $or: "OR",
      $not: "NOT",
    };
    const normalized: Record<string, any> = {};
    for (const [key, value] of Object.entries(filters)) {
      const normKey = keyMap[key] || key;
      if (!(normKey in normalized)) {
        normalized[normKey] = value;
      }
    }

    for (const [key, value] of Object.entries(normalized)) {
      // Handle logical operators
      if (key === "AND") {
        if (!Array.isArray(value)) {
          throw new Error(
            `AND filter value must be a list of filter dicts, got ${typeof value}`,
          );
        }
        // All conditions must match
        const allMatch = value.every((sub: SearchFilters) =>
          this.filterVector(vector, sub),
        );
        if (!allMatch) return false;
      } else if (key === "OR") {
        if (!Array.isArray(value)) {
          throw new Error(
            `OR filter value must be a list of filter dicts, got ${typeof value}`,
          );
        }
        // At least one condition must match
        const anyMatch = value.some((sub: SearchFilters) =>
          this.filterVector(vector, sub),
        );
        if (!anyMatch) return false;
      } else if (key === "NOT") {
        if (!Array.isArray(value)) {
          throw new Error(
            `NOT filter value must be a list of filter dicts, got ${typeof value}`,
          );
        }
        // None of the conditions should match
        const noneMatch = value.every(
          (sub: SearchFilters) => !this.filterVector(vector, sub),
        );
        if (!noneMatch) return false;
      } else {
        // Regular field condition
        if (!this.matchFieldCondition(vector.payload, key, value)) {
          return false;
        }
      }
    }

    return true;
  }
// 批量写入向量、id、payload。
  async insert(
    vectors: number[][],
    ids: string[],
    payloads: Record<string, any>[],
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO vectors (id, vector, payload) VALUES (?, ?, ?)`,
    );
    const insertMany = this.db.transaction(
      (vecs: number[][], vIds: string[], vPayloads: Record<string, any>[]) => {
        for (let i = 0; i < vecs.length; i++) {
          if (vecs[i].length !== this.dimension) {
            throw new Error(
              `Vector dimension mismatch. Expected ${this.dimension}, got ${vecs[i].length}`,
            );
          }
          const vectorBuffer = Buffer.from(new Float32Array(vecs[i]).buffer);
          stmt.run(vIds[i], vectorBuffer, JSON.stringify(vPayloads[i]));
        }
      },
    );
    insertMany(vectors, ids, payloads);
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().split(/\s+/).filter(Boolean);
  }
// 用关键词而不是向量做检索。使用BM25进行打分
  async keywordSearch(
    query: string,
    topK: number = 10,
    filters?: SearchFilters,
  ): Promise<VectorStoreResult[] | null> {
    try {
      const rows = this.db.prepare(`SELECT * FROM vectors`).all() as any[];

      // Collect documents that pass the filter
      const candidates: {
        id: string;
        payload: Record<string, any>;
        tokens: string[];
      }[] = [];

      for (const row of rows) {
        const payload = this.normalizePayload(JSON.parse(row.payload));
        const memoryVector: MemoryVector = {
          id: row.id,
          vector: Array.from(
            new Float32Array(
              row.vector.buffer,
              row.vector.byteOffset,
              row.vector.byteLength / 4,
            ),
          ),
          payload,
        };

        if (this.filterVector(memoryVector, filters)) {
          const text = payload.textLemmatized || payload.data || "";
          candidates.push({ id: row.id, payload, tokens: this.tokenize(text) });
        }
      }

      if (candidates.length === 0) {
        return [];
      }

      const tokenizedQuery = this.tokenize(query);
      if (tokenizedQuery.length === 0) {
        return [];
      }

      // Compute BM25 scores inline
      const k1 = 1.5;
      const b = 0.75;
      const N = candidates.length;
      const avgDocLength =
        candidates.reduce((sum, c) => sum + c.tokens.length, 0) / N;

      // Compute document frequency for query terms
      const docFreq = new Map<string, number>();
      for (const term of tokenizedQuery) {
        if (!docFreq.has(term)) {
          let count = 0;
          for (const c of candidates) {
            if (c.tokens.includes(term)) count++;
          }
          docFreq.set(term, count);
        }
      }

      // Compute IDF for query terms
      const idf = new Map<string, number>();
      for (const [term, freq] of docFreq) {
        idf.set(term, Math.log((N - freq + 0.5) / (freq + 0.5) + 1));
      }

      // Score each candidate
      const scored = candidates.map((candidate) => {
        let score = 0;
        const docLength = candidate.tokens.length;
        for (const term of tokenizedQuery) {
          const tf = candidate.tokens.filter((t) => t === term).length;
          const termIdf = idf.get(term) || 0;
          score +=
            (termIdf * tf * (k1 + 1)) /
            (tf + k1 * (1 - b + (b * docLength) / avgDocLength));
        }
        return { ...candidate, score };
      });

      // Filter out zero-score documents and sort descending
      const results = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((s) => ({
          id: s.id,
          payload: s.payload,
          score: s.score,
        }));

      return results;
    } catch (error) {
      console.error("Error during keyword search:", error);
      return null;
    }
  }
// 用向量相似度做检索。
  async search(
    query: number[],
    topK: number = 10,
    filters?: SearchFilters,
  ): Promise<VectorStoreResult[]> {
    if (query.length !== this.dimension) {
      throw new Error(
        `Query dimension mismatch. Expected ${this.dimension}, got ${query.length}`,
      );
    }

    const rows = this.db.prepare(`SELECT * FROM vectors`).all() as any[];
    const results: VectorStoreResult[] = [];

    for (const row of rows) {
      const vector = new Float32Array(
        row.vector.buffer,
        row.vector.byteOffset,
        row.vector.byteLength / 4,
      );
      const payload = this.normalizePayload(JSON.parse(row.payload));
      const memoryVector: MemoryVector = {
        id: row.id,
        vector: Array.from(vector),
        payload,
      };

      if (this.filterVector(memoryVector, filters)) {
        const score = this.cosineSimilarity(query, Array.from(vector));
        results.push({
          id: memoryVector.id,
          payload: memoryVector.payload,
          score,
        });
      }
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return results.slice(0, topK);
  }
// 根据 id 取一条向量记录。
  async get(vectorId: string): Promise<VectorStoreResult | null> {
    const row = this.db
      .prepare(`SELECT * FROM vectors WHERE id = ?`)
      .get(vectorId) as any;
    if (!row) return null;

    const payload = this.normalizePayload(JSON.parse(row.payload));
    return {
      id: row.id,
      payload,
    };
  }
// 更新某条记录的向量和 payload。
  async update(
    vectorId: string,
    vector: number[],
    payload: Record<string, any>,
  ): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(
        `Vector dimension mismatch. Expected ${this.dimension}, got ${vector.length}`,
      );
    }
    const vectorBuffer = Buffer.from(new Float32Array(vector).buffer);
    this.db
      .prepare(`UPDATE vectors SET vector = ?, payload = ? WHERE id = ?`)
      .run(vectorBuffer, JSON.stringify(payload), vectorId);
  }
// 根据 ID 删除一条向量记录。
  async delete(vectorId: string): Promise<void> {
    this.db.prepare(`DELETE FROM vectors WHERE id = ?`).run(vectorId);
  }
// 删除整张 vectors 表，然后重新初始化。
  async deleteCol(): Promise<void> {
    this.db.exec(`DROP TABLE IF EXISTS vectors`);
    this.init();
  }
// 列出符合过滤条件的向量记录。
// 不做相似度计算，只做读取和过滤。
  async list(
    filters?: SearchFilters,
    topK: number = 100,
  ): Promise<[VectorStoreResult[], number]> {
    const rows = this.db.prepare(`SELECT * FROM vectors`).all() as any[];
    const results: VectorStoreResult[] = [];

    for (const row of rows) {
      const payload = this.normalizePayload(JSON.parse(row.payload));
      const memoryVector: MemoryVector = {
        id: row.id,
        vector: Array.from(
          new Float32Array(
            row.vector.buffer,
            row.vector.byteOffset,
            row.vector.byteLength / 4,
          ),
        ),
        payload,
      };

      if (this.filterVector(memoryVector, filters)) {
        results.push({
          id: memoryVector.id,
          payload: memoryVector.payload,
        });
      }
    }

    return [results.slice(0, topK), results.length];
  }
// 从 memory_migrations 表里取 user_id。
  async getUserId(): Promise<string> {
    const row = this.db
      .prepare(`SELECT user_id FROM memory_migrations LIMIT 1`)
      .get() as any;
    if (row) {
      return row.user_id;
    }

    // Generate a random user_id if none exists
    const randomUserId =
      Math.random().toString(36).substring(2, 15) +
      Math.random().toString(36).substring(2, 15);
    this.db
      .prepare(`INSERT INTO memory_migrations (user_id) VALUES (?)`)
      .run(randomUserId);
    return randomUserId;
  }
// 清空 memory_migrations 后写入新的 user_id
  async setUserId(userId: string): Promise<void> {
    this.db.prepare(`DELETE FROM memory_migrations`).run();
    this.db
      .prepare(`INSERT INTO memory_migrations (user_id) VALUES (?)`)
      .run(userId);
  }

  async initialize(): Promise<void> {
    this.init();
  }
}
