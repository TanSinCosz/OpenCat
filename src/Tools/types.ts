import type { z } from "zod";
import { LRUCache } from 'lru-cache'
import { normalize } from 'path'
import type {
    AgentDefinition,
    AgentDefinitionsResult,
    AgentSource,
} from "./Agent/definitions.js";
import type { Runtime } from "../types/runtime.js";
import type { State } from "../types/state.js";

export type MaybePromise<T> = T | Promise<T>;

export type ToolInputSchema = z.ZodType | (() => z.ZodType);
export type ToolOutputSchema = z.ZodType | (() => z.ZodType);
export type ToolExecutionValue = unknown;

export type ToolResultFormatOptions<TOutput = ToolExecutionValue> = {
    output: TOutput;
};

export type JSONSchemaPrimitive = string | number | boolean | null;

export type JSONSchemaValue =
    | JSONSchemaPrimitive
    | JSONSchemaObject
    | JSONSchemaValue[];

export interface JSONSchemaObject {
    [key: string]: JSONSchemaValue;
}

export interface Tool<
    TInput = Record<string, unknown>,
    TOutput = ToolExecutionValue,
    TInputSchema extends ToolInputSchema = ToolInputSchema,
    TOutputSchema extends ToolOutputSchema = ToolOutputSchema,
> {
    name: string;
    inputSchema: TInputSchema;
    outputSchema: TOutputSchema
    inputJsonSchema?: JSONSchemaObject;
    maxResultSizeChars?: number;
    strict?: boolean;

    description(): MaybePromise<string>;
    prompt(): MaybePromise<string>;

    isEnabled?(): MaybePromise<boolean>;
    isConcurrencySafe?(): boolean;
    /**
     * Return the model-facing tool result immediately after execution.
     *
     * Tools can keep rich internal output for UI/state while sending the model
     * a concise result, matching the official tool-result mapping layer.
     */
    formatResult?(options: ToolResultFormatOptions<TOutput>): string;

    call(
        input: TInput,
        context: ToolUseContext,
        runtime: Runtime,
        state: State,
    ): MaybePromise<TOutput>;
}

export type FileState = {
    content: string
    timestamp: number
    offset: number | undefined
    limit: number | undefined
    // True when this entry was populated by auto-injection (e.g. CLAUDE.md) and
    // the injected content did not match disk (stripped HTML comments, stripped
    // frontmatter, truncated MEMORY.md). The model has only seen a partial view;
    // Edit/Write must require an explicit Read first. `content` here holds the
    // RAW disk bytes (for getChangedFiles diffing), not what the model saw.
    isPartialView?: boolean
}

export class FileStateCache {
    private cache: LRUCache<string, FileState>

    constructor(maxEntries: number, maxSizeBytes: number) {
        this.cache = new LRUCache<string, FileState>({
            max: maxEntries,
            maxSize: maxSizeBytes,
            sizeCalculation: value => Math.max(1, Buffer.byteLength(value.content)),
        })
    }

    get(key: string): FileState | undefined {
        return this.cache.get(normalize(key))
    }

    set(key: string, value: FileState): this {
        this.cache.set(normalize(key), value)
        return this
    }

    clear(): void {
        this.cache.clear()
    }

    get size(): number {
        return this.cache.size
    }

    get max(): number {
        return this.cache.max
    }

    get maxSize(): number {
        return this.cache.maxSize
    }

    entries(): Generator<[string, FileState]> {
        return this.cache.entries()
    }

    dump(): ReturnType<LRUCache<string, FileState>['dump']> {
        return this.cache.dump()
    }

    load(entries: ReturnType<LRUCache<string, FileState>['dump']>): void {
        this.cache.load(entries)
    }
}

export const READ_FILE_STATE_CACHE_SIZE = 100;
export const READ_FILE_STATE_CACHE_MAX_SIZE_BYTES = 25 * 1024 * 1024;

export function createFileStateCache(
    maxEntries = READ_FILE_STATE_CACHE_SIZE,
    maxSizeBytes = READ_FILE_STATE_CACHE_MAX_SIZE_BYTES,
): FileStateCache {
    return new FileStateCache(maxEntries, maxSizeBytes);
}

export function cloneFileStateCache(cache: FileStateCache): FileStateCache {
    const cloned = new FileStateCache(cache.max, cache.maxSize);
    cloned.load(cache.dump());
    return cloned;
}

export function cacheToObject(cache: FileStateCache): Record<string, FileState> {
    return Object.fromEntries(cache.entries());
}

export type Tools = readonly Tool[]

export type ToolPermissionDecision =
    | { behavior: "allow"; updatedInput?: unknown }
    | { behavior: "deny"; message: string };
 
export type CanUseToolFn = (
    tool: Tool,
    input: unknown,
    context: ToolUseContext,
    runtime: Runtime,
    state: State,
) => MaybePromise<ToolPermissionDecision>;

export type ToolUseContext = {
    agentDefinitions: AgentDefinitionsResult
    abortController: AbortController
    skillRuntime: SkillRuntimeState
    /** 当前运行的工具授权；计划切换和技能临时授权直接更新此对象。 */
    permissionContext: ToolPermissionContext
    readFileState: FileStateCache
    canUseTool?: CanUseToolFn
}

export type CreateToolUseContextOptions = {
    permissionContext?: ToolPermissionContext
    abortController?: AbortController
    agentDefinitions?: AgentDefinitionsResult
    readFileState?: FileStateCache
    canUseTool?: CanUseToolFn
}

export function createToolUseContext(
    options: CreateToolUseContextOptions = {},
): ToolUseContext {
    return {
        agentDefinitions: options.agentDefinitions ?? {
            activeAgents: [],
            allAgents: [],
        },
        abortController: options.abortController ?? new AbortController(),
        skillRuntime: createSkillRuntimeState(),
        permissionContext: options.permissionContext ?? getEmptyToolPermissionContext(),
        readFileState: options.readFileState ?? createFileStateCache(),
        canUseTool: options.canUseTool,
    }
}

export type SkillCommand = {
    name: string
    description: string
    content: string
    allowedTools?: string[]
    executionContext?: "fork"
    paths?: string[]
    skillDir?: string
    skillPath?: string
}

export type SkillRuntimeState = {
    checkedSkillDirs: Set<string>
    dynamicSkills: Map<string, SkillCommand>
    conditionalSkills: Map<string, SkillCommand>
}

export function createSkillRuntimeState(): SkillRuntimeState {
    return {
        checkedSkillDirs: new Set(),
        dynamicSkills: new Map(),
        conditionalSkills: new Map(),
    }
}

// Agent section
export type {
    AgentDefinition,
    AgentDefinitionsResult,
    AgentSource,
}

export function getEmptyToolPermissionContext(): ToolPermissionContext {
    return {
        mode: 'default',
        alwaysAllowRules: {},
    }
}

export type PermissionMode =
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'dontAsk'
    | 'plan'

export type PermissionRuleSource =
    | 'userSettings'
    | 'projectSettings'
    | 'localSettings'
    | 'flagSettings'
    | 'policySettings'
    | 'cliArg'
    | 'command'
    | 'session'

export type ToolPermissionRulesBySource = {
    [T in PermissionRuleSource]?: string[]
}

export type ToolPermissionContext = {
    mode: PermissionMode
    /** command 规则由 ReadSkill 临时授权，query 结束时清理；其他来源保留。 */
    alwaysAllowRules: ToolPermissionRulesBySource
}
