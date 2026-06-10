import { DeepSeekClient } from "../deepseek/client.js";
import { createDeepSeekClient } from "../deepseek/client.js";
import { OpenAIEmbedder } from "./Embedding/Embedding.js";
import { MemoryConfig, AddMemoryOptions, SearchResult, SearchFilters, MemoryItem } from "./type.js";
import { VectorStore } from "./VectorStore/base.js";
import { MemoryVectorStore } from "./VectorStore/VectorStore.js";
import { HistoryManager } from "./HistoryStore/base.js";
import { SQLiteManager } from "./HistoryStore/HistoryStore.js";
import { Message } from "./type.js";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";
import { lemmatizeForBm25CN } from "./utils/lemmatizeCN.js";
import { lemmatizeForBm25 } from "./utils/lemmatizeEng.js";
import { ADDITIVE_EXTRACTION_PROMPT, AGENT_CONTEXT_SUFFIX } from "./prompt.js";
import { generateAdditiveExtractionPrompt } from "./utils/prompt.js";
import { extractEntities, extractEntitiesBatch } from "./utils/entity_extraction.js";
import { OpenAIStructuredLLM } from "./LLM/LLM.js";
import { SearchMemoryOptions } from "./type.js";
import { scoreAndRank, getBm25Params, ENTITY_BOOST_WEIGHT } from "./utils/scoring.js";
import os from "os";
import path from "path";
import { extractJson } from "./utils/extractJson.js";
import { z } from "zod";


export const AdditiveExtractionSchema = z.object({
    memory: z.array(
        z.object({
            id: z.string(),
            text: z.string(),
            attributed_to: z.enum(["user", "assistant"]).optional(),
            linked_memory_ids: z.array(z.string()).optional(),
        }),
    ),
});


export class MemoryTool {
    private config: MemoryConfig;
    private embedder: OpenAIEmbedder;
    private llm: OpenAIStructuredLLM;
    private vectorStore!: VectorStore;
    private db: HistoryManager;
    telemetryId: string
    private _entityStore?: VectorStore;
    private customInstructions: string | undefined;

    constructor(config: MemoryConfig) {
        this.config = config;
        this.embedder = new OpenAIEmbedder(config.embedder.config);
        this.db = new SQLiteManager(config.historyDbPath || ":memory:")

        this.llm = new OpenAIStructuredLLM(config.llm)
        this.vectorStore = new MemoryVectorStore(this.config.vectorStore.config);
        this.telemetryId = "anonymous";
    }
    private buildSessionScope(filters: SearchFilters): string {
        const parts: string[] = [];
        for (const key of ["agent_id", "run_id", "user_id"].sort()) {
            const val = (filters as any)[key];
            if (val) parts.push(`${key}=${val}`);
        }
        return parts.join("&");
    }

    async search(
        query: string,
        config: SearchMemoryOptions,
    ): Promise<SearchResult> {

        // Validate and trim entity IDs in filters. Only include keys whose
        // validated value is defined — otherwise downstream vector stores
        // receive `agent_id: undefined` / `run_id: undefined` and fail
        // (Qdrant rejects the malformed match, pgvector binds NULL, Redis
        // emits a literal "undefined" string in TAG filters).
        const normalizedFilters: Record<string, any> = config.filters
            ? Object.fromEntries(
                Object.entries({
                    ...config.filters,
                    user_id: validateAndTrimEntityId(config.filters.user_id, "user_id"),
                    agent_id: validateAndTrimEntityId(
                        config.filters.agent_id,
                        "agent_id",
                    ),
                    run_id: validateAndTrimEntityId(config.filters.run_id, "run_id"),
                }).filter(([, v]) => v !== undefined),
            )
            : {};

        const { topK = 20, threshold = 0.1, explain = false } = config;


        let effectiveFilters: Record<string, any> = { ...normalizedFilters };

        // Apply enhanced metadata filtering if advanced operators are detected
        if (this._hasAdvancedOperators(effectiveFilters)) {
            const processedFilters = this._processMetadataFilters(effectiveFilters);
            // Remove logical/operator keys that have been reprocessed
            for (const logicalKey of ["AND", "OR", "NOT"]) {
                delete effectiveFilters[logicalKey];
            }
            for (const fk of Object.keys(effectiveFilters)) {
                if (
                    !["AND", "OR", "NOT", "user_id", "agent_id", "run_id"].includes(fk) &&
                    typeof effectiveFilters[fk] === "object" &&
                    effectiveFilters[fk] !== null
                ) {
                    delete effectiveFilters[fk];
                }
            }
            effectiveFilters = { ...effectiveFilters, ...processedFilters };
        }

        // Validate filters contains at least one entity ID (snake_case)
        if (
            !effectiveFilters.user_id &&
            !effectiveFilters.agent_id &&
            !effectiveFilters.run_id
        ) {
            throw new Error(
                "filters must contain at least one of: user_id, agent_id, run_id. " +
                "Example: filters: { user_id: 'u1' }",
            );
        }

        // Step 1: Preprocess query
        const queryLemmatized = lemmatizeForBm25(query);
        const queryEntities = extractEntities(query);

        // Step 2: Embed query
        const queryEmbedding = await this.embedder.embed(query);

        // Step 3: Semantic search (over-fetch for scoring pool)
        const internalLimit = Math.max(topK * 4, 60);
        const semanticResults = await this.vectorStore.search(
            queryEmbedding,
            internalLimit,
            effectiveFilters,
        );

        // Step 4: Keyword search (if store supports it)
        const keywordResults =
            typeof this.vectorStore.keywordSearch === "function"
                ? (await this.vectorStore.keywordSearch(
                    queryLemmatized,
                    internalLimit,
                    effectiveFilters,
                )) ?? []
                : [];
        // Step 5: Compute BM25 scores from keyword results
        const bm25Scores: Record<string, number> = {};
        if (keywordResults) {
            const [midpoint, steepness] = getBm25Params(query, queryLemmatized);
            for (const mem of keywordResults) {
                const memId = String(mem.id);
                const rawScore = mem.score ?? 0;
                if (rawScore > 0) {
                    bm25Scores[memId] = normalizeBm25(rawScore, midpoint, steepness);
                }
            }
        }

        // Step 6: Compute entity boosts
        const entityBoosts: Record<string, number> = {};
        if (queryEntities.length > 0) {
            try {
                // Deduplicate entities (max 8)
                const seen = new Set<string>();
                const deduped: Array<{ type: string; text: string }> = [];
                for (const entity of queryEntities.slice(0, 8)) {
                    const key = entity.text.trim().toLowerCase();
                    if (key && !seen.has(key)) {
                        seen.add(key);
                        deduped.push(entity);
                    }
                }

                if (deduped.length > 0) {
                    const entityStore = await this.getEntityStore();
                    const entitySearchFilters: Record<string, any> = {};
                    for (const k of ["user_id", "agent_id", "run_id"] as const) {
                        if (effectiveFilters[k])
                            entitySearchFilters[k] = effectiveFilters[k];
                    }
                    const entityTexts = deduped.map((e) => e.text);
                    const embeddings = await this.embedder.embedBatch(entityTexts);

                    if (embeddings.length !== entityTexts.length) {
                        console.warn(
                            `embedBatch returned ${embeddings.length} vectors for ${entityTexts.length} texts — skipping entity boost`,
                        );
                    } else {
                        const searchResults = await Promise.allSettled(
                            deduped.map((_, i) =>
                                entityStore.search(embeddings[i], 500, entitySearchFilters),
                            ),
                        );

                        for (const result of searchResults) {
                            if (result.status === "rejected") {
                                console.warn(
                                    "Entity boost search failed for one entity:",
                                    result.reason,
                                );
                                continue;
                            }

                            for (const match of result.value) {
                                const similarity = match.score ?? 0;
                                if (similarity < 0.5) continue;

                                const payload = match.payload || {};
                                const linkedMemoryIds = payload.linkedMemoryIds ?? [];
                                if (!Array.isArray(linkedMemoryIds)) continue;

                                const numLinked = Math.max(linkedMemoryIds.length, 1);
                                const memoryCountWeight =
                                    1.0 / (1.0 + 0.001 * (numLinked - 1) ** 2);
                                const boost =
                                    similarity * ENTITY_BOOST_WEIGHT * memoryCountWeight;

                                for (const memoryId of linkedMemoryIds) {
                                    if (memoryId) {
                                        const memKey = String(memoryId);
                                        entityBoosts[memKey] = Math.max(
                                            entityBoosts[memKey] ?? 0,
                                            boost,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("Entity boost computation failed:", e);
            }
        }

        // Step 7: Build candidate set from semantic results
        const candidates = semanticResults.map((mem) => ({
            id: String(mem.id),
            score: mem.score ?? 0,
            payload: mem.payload || {},
        }));

        // Step 8: Score and rank
        const scoredResults = scoreAndRank(
            candidates,
            bm25Scores,
            entityBoosts,
            threshold ?? 0.1,
            topK,
            explain,
        );

        // Step 9: Format results
        const excludedKeys = new Set([
            "user_id",
            "agent_id",
            "run_id",
            "hash",
            "data",
            "createdAt",
            "updatedAt",
            "textLemmatized",
            "attributedTo",
        ]);

        const results = scoredResults
            .filter((scored) => scored.payload?.data)
            .map((scored) => {
                const payload = scored.payload || {};
                return {
                    id: scored.id,
                    memory: payload.data,
                    hash: payload.hash,
                    createdAt: payload.createdAt,
                    updatedAt: payload.updatedAt,
                    score: scored.score,
                    metadata: Object.entries(payload)
                        .filter(([key]) => !excludedKeys.has(key))
                        .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {}),
                    ...(payload.user_id && { user_id: payload.user_id }),
                    ...(payload.agent_id && { agent_id: payload.agent_id }),
                    ...(payload.run_id && { run_id: payload.run_id }),
                    ...(scored.scoreDetails && { score_details: scored.scoreDetails }),
                };
            });

        return {
            results,
        };
    }


    async add(
        messages: string | Message[],
        config: AddMemoryOptions,
    ): Promise<SearchResult> {
        // Validate messages input
        if (messages === undefined || messages === null) {
            throw new Error(
                "messages is required and cannot be undefined or null. Provide a string or array of messages.",
            );
        }

        const { metadata = {}, filters = {}, infer = true } = config;

        // Validate and trim entity IDs
        const userId = validateAndTrimEntityId(config.userId, "userId");
        const agentId = validateAndTrimEntityId(config.agentId, "agentId");
        const runId = validateAndTrimEntityId(config.runId, "runId");

        // Convert camelCase entity params to snake_case for storage (matches API and search/getAll filters)
        if (userId) filters.user_id = metadata.user_id = userId;
        if (agentId) filters.agent_id = metadata.agent_id = agentId;
        if (runId) filters.run_id = metadata.run_id = runId;

        if (!filters.user_id && !filters.agent_id && !filters.run_id) {
            throw new Error(
                "One of the filters: userId, agentId or runId is required!",
            );
        }

        const parsedMessages =
            Array.isArray(messages) ? (messages as Message[]) : [{ role: "user", content: messages }];

        // const final_parsedMessages = await parse_vision_messages(parsedMessages);

        // Add to vector store
        // filter 目前有user_id、agent_id、run_id的过滤
        const vectorStoreResult = await this.addToVectorStore(
            parsedMessages,
            metadata,
            filters,
            infer,
        );

        return {
            results: vectorStoreResult,
        };
    }
    private async createMemory(
        data: string,
        existingEmbeddings: Record<string, number[]>,
        metadata: Record<string, any>,
    ): Promise<string> {
        const memoryId = uuidv4();
        const embedding =
            existingEmbeddings[data] || (await this.embedder.embed(data));

        const memoryMetadata = {
            ...metadata,
            data,
            hash: createHash("md5").update(data).digest("hex"),
            textLemmatized: lemmatizeForBm25(data),
            createdAt: new Date().toISOString(),
        };

        await this.vectorStore.insert([embedding], [memoryId], [memoryMetadata]);
        await this.db.addHistory(
            memoryId,
            null,
            data,
            "ADD",
            memoryMetadata.createdAt,
        );

        return memoryId;
    }


    private async addToVectorStore(
        messages: Message[],
        metadata: Record<string, any>,
        filters: SearchFilters,
        infer: boolean,
    ): Promise<MemoryItem[]> {
        if (!infer) {
            const returnedMemories: MemoryItem[] = [];
            for (const message of messages) {
                if (message.content === "system") {
                    continue;
                }
                const memoryId = await this.createMemory(
                    message.content as string,
                    {},
                    metadata,
                );
                returnedMemories.push({
                    id: memoryId,
                    memory: message.content as string,
                    metadata: { event: "ADD" },
                });
            }
            return returnedMemories;
        }

        // === V3 PHASED BATCH PIPELINE ===

        // Phase 0: Context gathering
        const sessionScope = this.buildSessionScope(filters);
        let lastMessages: Array<{
            role: string;
            content: string;
            name?: string;
        }> = [];
        if (typeof this.db.getLastMessages === "function") {
            try {
                lastMessages = await this.db.getLastMessages(sessionScope, 10);
            } catch {
                // getLastMessages not supported — proceed without context
            }
        }
        const parsedMessages = messages.map((m) => m.content).join("\n");

        // Phase 1: Existing memory retrieval
        const queryEmbedding = await this.embedder.embed(parsedMessages);
        const existingResults = await this.vectorStore.search(
            queryEmbedding,
            10,
            filters,
        );

        // Map UUIDs to integers (anti-hallucination)
        const existingMemories: Array<{ id: string; text: string }> = [];
        const uuidMapping: Record<string, string> = {};
        for (let idx = 0; idx < existingResults.length; idx++) {
            const mem = existingResults[idx];
            uuidMapping[String(idx)] = mem.id;
            existingMemories.push({
                id: String(idx),
                text: mem.payload?.data ?? "",
            });
        }

        // Phase 2: LLM extraction (single call)
        const isAgentScoped = !!filters.agent_id && !filters.user_id;
        let systemPrompt = ADDITIVE_EXTRACTION_PROMPT;
        if (isAgentScoped) {
            systemPrompt += AGENT_CONTEXT_SUFFIX;
        }

        const userPrompt = generateAdditiveExtractionPrompt({
            existingMemories,
            newMessages: parsedMessages,
            lastKMessages: lastMessages,
            customInstructions: this.customInstructions,
        });

        let response: string;
        try {
            response = (await this.llm.generateResponse(
                [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                { type: "json_object" },
            )) as string;
        } catch (e) {
            console.error("LLM extraction failed:", e);
            return [];
        }

        // Parse response
        let extractedMemories: Array<{
            id?: string;
            text?: string;
            attributed_to?: string;
            linked_memory_ids?: string[];
        }> = [];
        try {
            const cleanResponse = extractJson(response);
            if (cleanResponse && cleanResponse.trim()) {
                try {
                    const parsed = AdditiveExtractionSchema.parse(
                        JSON.parse(cleanResponse),
                    );
                    extractedMemories = parsed.memory;
                } catch {
                    const fallbackJson = extractJson(cleanResponse);
                    extractedMemories = JSON.parse(fallbackJson)?.memory ?? [];
                }
            }
        } catch (e) {
            console.error("Error parsing extraction response:", e);
            extractedMemories = [];
        }

        if (extractedMemories.length === 0) {
            // Save messages even if nothing extracted
            if (typeof this.db.saveMessages === "function") {
                try {
                    await this.db.saveMessages(
                        messages.map((m) => ({
                            role: m.role,
                            content: m.content as string,
                        })),
                        sessionScope,
                    );
                } catch { }
            }
            return [];
        }

        // Phase 3: Batch embed all extracted memory texts
        const memTexts = extractedMemories
            .map((m) => m.text ?? "")
            .filter((t) => t.length > 0);
        let embedMap: Record<string, number[]> = {};
        try {
            const memEmbeddingsList = await this.embedder.embedBatch(memTexts);
            for (let i = 0; i < memTexts.length; i++) {
                embedMap[memTexts[i]] = memEmbeddingsList[i];
            }
        } catch {
            // Fallback: embed individually
            for (const text of memTexts) {
                try {
                    embedMap[text] = await this.embedder.embed(text);
                } catch (e) {
                    console.warn(`Failed to embed memory text: ${e}`);
                }
            }
        }

        // Phase 4-5: CPU processing + hash dedup
        const existingHashes = new Set<string>();
        for (const mem of existingResults) {
            const h = mem.payload?.hash;
            if (h) existingHashes.add(h);
        }

        const records: Array<{
            memoryId: string;
            text: string;
            embedding: number[];
            payload: Record<string, any>;
        }> = [];
        const seenHashes = new Set<string>();

        for (const mem of extractedMemories) {
            const text = mem.text;
            if (!text || !(text in embedMap)) continue;

            const memHash = createHash("md5").update(text).digest("hex");
            if (existingHashes.has(memHash) || seenHashes.has(memHash)) {
                continue;
            }
            seenHashes.add(memHash);

            const textLemmatized = lemmatizeForBm25(text);
            const memoryId = uuidv4();
            const now = new Date().toISOString();

            const memPayload: Record<string, any> = {
                ...metadata,
                data: text,
                textLemmatized,
                hash: memHash,
                createdAt: now,
                updatedAt: now,
            };
            if (mem.attributed_to) {
                memPayload.attributedTo = mem.attributed_to;
            }
            if (mem.linked_memory_ids?.length) {
                memPayload.linkedMemoryIds = Array.from(
                    new Set(mem.linked_memory_ids),
                ).sort();
            }
            if (filters.user_id) memPayload.user_id = filters.user_id;
            if (filters.agent_id) memPayload.agent_id = filters.agent_id;
            if (filters.run_id) memPayload.run_id = filters.run_id;

            records.push({
                memoryId,
                text,
                embedding: embedMap[text],
                payload: memPayload,
            });
        }

        if (records.length === 0) {
            if (typeof this.db.saveMessages === "function") {
                try {
                    await this.db.saveMessages(
                        messages.map((m) => ({
                            role: m.role,
                            content: m.content as string,
                        })),
                        sessionScope,
                    );
                } catch { }
            }
            return [];
        }

        // Phase 6: Batch persist
        const allVectors = records.map((r) => r.embedding);
        const allIds = records.map((r) => r.memoryId);
        const allPayloads = records.map((r) => r.payload);

        try {
            await this.vectorStore.insert(allVectors, allIds, allPayloads);
        } catch {
            // Fallback: insert one by one
            for (let i = 0; i < allIds.length; i++) {
                try {
                    await this.vectorStore.insert(
                        [allVectors[i]],
                        [allIds[i]],
                        [allPayloads[i]],
                    );
                } catch (e) {
                    console.error(`Failed to insert memory ${allIds[i]}: ${e}`);
                }
            }
        }

        // Batch history
        const historyRecords = records.map((r) => ({
            memoryId: r.memoryId,
            previousValue: null as string | null,
            newValue: r.text as string | null,
            action: "ADD",
            createdAt: r.payload.createdAt as string | undefined,
            updatedAt: undefined as string | undefined,
            isDeleted: 0,
        }));

        if (typeof this.db.batchAddHistory === "function") {
            try {
                await this.db.batchAddHistory(historyRecords);
            } catch {
                // Fallback: add one by one
                for (const hr of historyRecords) {
                    try {
                        await this.db.addHistory(
                            hr.memoryId,
                            null,
                            hr.newValue,
                            "ADD",
                            hr.createdAt,
                        );
                    } catch (e) {
                        console.error(`Failed to add history for ${hr.memoryId}: ${e}`);
                    }
                }
            }
        } else {
            for (const hr of historyRecords) {
                try {
                    await this.db.addHistory(
                        hr.memoryId,
                        null,
                        hr.newValue,
                        "ADD",
                        hr.createdAt,
                    );
                } catch (e) {
                    console.error(`Failed to add history for ${hr.memoryId}: ${e}`);
                }
            }
        }

        // Phase 7: Batch entity linking
        try {
            const allTexts = records.map((r) => r.text);
            const allEntities = extractEntitiesBatch(allTexts);

            // 7a: Global dedup — collect unique entities across all memories
            const globalEntities: Record<
                string,
                { entityType: string; entityText: string; memoryIds: Set<string> }
            > = {};
            for (let idx = 0; idx < records.length; idx++) {
                const memoryId = records[idx].memoryId;
                const entities = idx < allEntities.length ? allEntities[idx] : [];
                for (const entity of entities) {
                    const key = entity.text.trim().toLowerCase();
                    if (key in globalEntities) {
                        globalEntities[key].memoryIds.add(memoryId);
                    } else {
                        globalEntities[key] = {
                            entityType: entity.type,
                            entityText: entity.text,
                            memoryIds: new Set([memoryId]),
                        };
                    }
                }
            }

            const orderedKeys = Object.keys(globalEntities);
            if (orderedKeys.length > 0) {
                const entityTexts = orderedKeys.map(
                    (k) => globalEntities[k].entityText,
                );

                // 7b: Single batch embed for all unique entities
                let entityEmbeddings: (number[] | null)[];
                try {
                    entityEmbeddings = await this.embedder.embedBatch(entityTexts);
                } catch {
                    // Fallback: embed individually
                    entityEmbeddings = [];
                    for (const t of entityTexts) {
                        try {
                            entityEmbeddings.push(await this.embedder.embed(t));
                        } catch {
                            entityEmbeddings.push(null);
                        }
                    }
                }

                // Filter out entities with failed embeddings
                const valid: Array<{ index: number; key: string }> = [];
                for (let i = 0; i < orderedKeys.length; i++) {
                    if (entityEmbeddings[i] !== null) {
                        valid.push({ index: i, key: orderedKeys[i] });
                    }
                }

                if (valid.length > 0) {
                    const entityStore = await this.getEntityStore();

                    // 7c: Search for existing entities one by one (no batch search)
                    const toInsertVectors: number[][] = [];
                    const toInsertIds: string[] = [];
                    const toInsertPayloads: Record<string, any>[] = [];

                    for (const { index: j, key } of valid) {
                        const { entityType, entityText, memoryIds } = globalEntities[key];
                        const entityVec = entityEmbeddings[j]!;

                        let matches: Array<{
                            id: string;
                            score?: number;
                            payload: Record<string, any>;
                        }> = [];
                        try {
                            matches = await entityStore.search(entityVec, 1, filters);
                        } catch { }

                        if (matches.length > 0 && (matches[0].score ?? 0) >= 0.95) {
                            // Update existing entity
                            const match = matches[0];
                            const payload = match.payload || {};
                            const linked = new Set<string>(payload.linkedMemoryIds ?? []);
                            for (const mid of memoryIds) linked.add(mid);
                            payload.linkedMemoryIds = Array.from(linked).sort();
                            try {
                                await entityStore.update(match.id, entityVec, payload);
                            } catch (e) {
                                console.debug(`Entity update failed for '${entityText}': ${e}`);
                            }
                        } else {
                            // New entity — collect for batch insert
                            const entityPayload: Record<string, any> = {
                                data: entityText,
                                entityType,
                                linkedMemoryIds: Array.from(memoryIds).sort(),
                            };
                            if (filters.user_id) entityPayload.user_id = filters.user_id;
                            if (filters.agent_id) entityPayload.agent_id = filters.agent_id;
                            if (filters.run_id) entityPayload.run_id = filters.run_id;

                            toInsertVectors.push(entityVec);
                            toInsertIds.push(uuidv4());
                            toInsertPayloads.push(entityPayload);
                        }
                    }

                    // 7e: Single batch insert for all new entities
                    if (toInsertVectors.length > 0) {
                        try {
                            await entityStore.insert(
                                toInsertVectors,
                                toInsertIds,
                                toInsertPayloads,
                            );
                        } catch (e) {
                            console.warn(`Batch entity insert failed: ${e}`);
                        }
                    }
                }
            }
        } catch (e) {
            console.warn(`Batch entity linking failed: ${e}`);
        }

        // Phase 8: Save messages + return
        if (typeof this.db.saveMessages === "function") {
            try {
                await this.db.saveMessages(
                    messages.map((m) => ({
                        role: m.role,
                        content: m.content as string,
                    })),
                    sessionScope,
                );
            } catch { }
        }

        return records.map((r) => ({
            id: r.memoryId,
            memory: r.text,
            metadata: { event: "ADD" },
        }));
    }
    private async getEntityStore(): Promise<VectorStore> {
        if (!this._entityStore) {
            const entityConfig = this.config.vectorStore.config;

            // For file-based stores (memory/SQLite), always use a separate DB for entities

            const basePath = entityConfig.dbPath || getDefaultVectorStoreDbPath();
            entityConfig.dbPath = basePath.replace(/\.db$/, "_entities.db");

            this._entityStore = new MemoryVectorStore(
                entityConfig,
            );
            await this._entityStore.initialize();
        }
        return this._entityStore;
    }
    private _hasAdvancedOperators(filters: Record<string, any>): boolean {
        if (!filters || typeof filters !== "object") {
            return false;
        }

        for (const [key, value] of Object.entries(filters)) {
            // Check for platform-style logical operators
            if (key === "AND" || key === "OR" || key === "NOT") {
                return true;
            }
            // Check for comparison operators
            if (
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value)
            ) {
                for (const op of Object.keys(value)) {
                    if (
                        [
                            "eq",
                            "ne",
                            "gt",
                            "gte",
                            "lt",
                            "lte",
                            "in",
                            "nin",
                            "contains",
                            "icontains",
                        ].includes(op)
                    ) {
                        return true;
                    }
                }
            }
            // Check for wildcard values
            if (value === "*") {
                return true;
            }
        }
        return false;
    }
    private _processMetadataFilters(
        metadataFilters: Record<string, any>,
    ): Record<string, any> {
        const processedFilters: Record<string, any> = {};

        const processCondition = (
            key: string,
            condition: any,
        ): Record<string, any> => {
            if (typeof condition !== "object" || condition === null) {
                // Simple equality: {"key": "value"} or wildcard
                if (condition === "*") {
                    return { [key]: "*" };
                }
                return { [key]: condition };
            }

            if (Array.isArray(condition)) {
                // Array shorthand for "in" operator
                return { [key]: { in: condition } };
            }

            const result: Record<string, any> = {};
            const operatorMap: Record<string, string> = {
                eq: "eq",
                ne: "ne",
                gt: "gt",
                gte: "gte",
                lt: "lt",
                lte: "lte",
                in: "in",
                nin: "nin",
                contains: "contains",
                icontains: "icontains",
            };

            for (const [operator, value] of Object.entries(condition)) {
                if (operator in operatorMap) {
                    if (!result[key]) {
                        result[key] = {};
                    }
                    result[key][operatorMap[operator]] = value;
                } else {
                    throw new Error(`Unsupported metadata filter operator: ${operator}`);
                }
            }
            return result;
        };

        for (const [key, value] of Object.entries(metadataFilters)) {
            if (key === "AND") {
                // Logical AND: combine multiple conditions
                if (!Array.isArray(value)) {
                    throw new Error("AND operator requires a list of conditions");
                }
                for (const condition of value) {
                    for (const [subKey, subValue] of Object.entries(condition)) {
                        Object.assign(processedFilters, processCondition(subKey, subValue));
                    }
                }
            } else if (key === "OR") {
                // Logical OR: Pass through to vector store for implementation-specific handling
                if (!Array.isArray(value) || value.length === 0) {
                    throw new Error(
                        "OR operator requires a non-empty list of conditions",
                    );
                }
                processedFilters["$or"] = [];
                for (const condition of value) {
                    const orCondition: Record<string, any> = {};
                    for (const [subKey, subValue] of Object.entries(
                        condition as Record<string, any>,
                    )) {
                        Object.assign(orCondition, processCondition(subKey, subValue));
                    }
                    processedFilters["$or"].push(orCondition);
                }
            } else if (key === "NOT") {
                // Logical NOT: Pass through to vector store for implementation-specific handling
                if (!Array.isArray(value) || value.length === 0) {
                    throw new Error(
                        "NOT operator requires a non-empty list of conditions",
                    );
                }
                processedFilters["$not"] = [];
                for (const condition of value) {
                    const notCondition: Record<string, any> = {};
                    for (const [subKey, subValue] of Object.entries(
                        condition as Record<string, any>,
                    )) {
                        Object.assign(notCondition, processCondition(subKey, subValue));
                    }
                    processedFilters["$not"].push(notCondition);
                }
            } else {
                Object.assign(processedFilters, processCondition(key, value));
            }
        }

        return processedFilters;
    }

}




function validateAndTrimEntityId(
    value: string | undefined,
    name: string,
): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed === "") {
        throw new Error(
            `Invalid ${name}: cannot be empty or whitespace-only. Provide a valid identifier.`,
        );
    }
    if (/\s/.test(trimmed)) {
        throw new Error(
            `Invalid ${name}: cannot contain whitespace. Provide a valid identifier without spaces.`,
        );
    }
    return trimmed;

}

/**
 * Normalize a raw BM25 score to [0, 1] using logistic sigmoid.
 *
 * @param rawScore - Raw BM25 score (unbounded, typically 0-20+).
 * @param midpoint - Score at which sigmoid outputs 0.5.
 * @param steepness - Controls how quickly sigmoid transitions.
 * @returns Normalized score in range [0, 1].
 */
export function normalizeBm25(
    rawScore: number,
    midpoint: number,
    steepness: number,
): number {
    return 1.0 / (1.0 + Math.exp(-steepness * (rawScore - midpoint)));
}

export interface ScoreDetails {
    semanticScore: number;
    bm25Score: number;
    entityBoost: number;
    rawScore: number;
    maxPossibleScore: number;
    finalScore: number;
    threshold: number;
}

export interface ScoredResult {
    id: string;
    score: number;
    payload: Record<string, any>;
    scoreDetails?: ScoreDetails;
}
export function getDefaultVectorStoreDbPath(): string {
  return path.join(os.homedir(), ".mem0", "vector_store.db");
}




export default MemoryTool;
