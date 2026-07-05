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
import type { Tokenizer } from "./utils/Tokenizer.js";


export type MaybePromise<T> = T | Promise<T>;

export type ToolInputSchema = z.ZodType | (() => z.ZodType);
export type ToolOutputSchema = z.ZodType | (() => z.ZodType);
export type ToolExecutionValue = unknown;

export type JSONSchemaPrimitive = string | number | boolean | null;

export type JSONSchemaValue =
    | JSONSchemaPrimitive
    | JSONSchemaObject
    | JSONSchemaValue[];

export interface JSONSchemaObject {
    [key: string]: JSONSchemaValue;
}


export interface BackgroundTask {
    id: string
    command: string
    status: 'running' | 'completed' | 'failed' | 'killed'
    stdout: string
    stderr: string
    exitCode?: number
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
    searchHint?: string;
    shouldDefer?: boolean;
    alwaysLoad?: boolean;
    strict?: boolean;

    description(): MaybePromise<string>;
    prompt(): MaybePromise<string>;

    isEnabled?(): MaybePromise<boolean>;
    userFacingName?(): string;
    isConcurrencySafe?(): boolean;

    call(
        input: TInput,
        context: ToolUseContext,
        runtime: Runtime,
        state: State,
    ): MaybePromise<TOutput>;
}


interface AbortController {
    /**
     * The **`signal`** read-only property of the AbortController interface returns an AbortSignal object instance, which can be used to communicate with/abort an asynchronous operation as desired.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortController/signal)
     */
    readonly signal: AbortSignal;
    /**
     * The **`abort()`** method of the AbortController interface aborts an asynchronous operation before it has completed.
     *
     * [MDN Reference](https://developer.mozilla.org/docs/Web/API/AbortController/abort)
     */
    abort(reason?: any): void;
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

    has(key: string): boolean {
        return this.cache.has(normalize(key))
    }

    delete(key: string): boolean {
        return this.cache.delete(normalize(key))
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

    get calculatedSize(): number {
        return this.cache.calculatedSize
    }

    keys(): Generator<string> {
        return this.cache.keys()
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

export type ThinkingConfig =
    | { type: 'enabled' }
    | { type: 'disabled' }


export type ToolUseContext = {
    options: {
        tools: Tools
        isNonInteractiveSession: boolean
        mainLoopModel: string
        agentDefinitions: AgentDefinitionsResult
        thinkingConfig: ThinkingConfig
    }
    dynamicSkillDirTriggers?: Set<string> // 记录这轮工具调用因为访问某个路径而触发了哪些 skill 目录。
    abortController: AbortController
    skillRuntime: SkillRuntimeState
    getAppState(): AppState
    setAppState(f: (prev: AppState) => AppState): void
    readFileState: FileStateCache
    canUseTool?: CanUseToolFn
    tokenizer?: Tokenizer
}

export type CreateToolUseContextOptions = {
    tools?: Tools
    appState?: AppState
    abortController?: AbortController
    tokenizer?: Tokenizer
    isNonInteractiveSession?: boolean
    mainLoopModel?: string
    agentDefinitions?: AgentDefinitionsResult
    thinkingConfig?: ThinkingConfig
    readFileState?: FileStateCache
    canUseTool?: CanUseToolFn
}

export function createToolUseContext(
    options: CreateToolUseContextOptions = {},
): ToolUseContext {
    let appState =
        options.appState ?? { toolPermissionContext: getEmptyToolPermissionContext() }

    return {
        options: {
            tools: options.tools ?? [],
            isNonInteractiveSession: options.isNonInteractiveSession ?? false,
            mainLoopModel: options.mainLoopModel ?? '',
            agentDefinitions: options.agentDefinitions ?? {
                activeAgents: [],
                allAgents: [],
            },
            thinkingConfig: options.thinkingConfig ?? { type: 'disabled' },
        },
        dynamicSkillDirTriggers: new Set(),
        abortController: options.abortController ?? new AbortController(),
        skillRuntime: createSkillRuntimeState(),
        getAppState: () => appState,
        setAppState: update => {
            appState = update(appState)
        },
        readFileState: options.readFileState ?? createFileStateCache(),
        canUseTool: options.canUseTool,
        tokenizer: options.tokenizer,
    }
}

export type SkillCommand = {
    name: string
    description: string
    content: string
    paths?: string[]
    skillDir?: string
    skillPath?: string
}


export type SkillRuntimeState = {
    checkedSkillDirs: Set<string>
    dynamicSkills: Map<string, SkillCommand>
    conditionalSkills: Map<string, SkillCommand>
    activatedConditionalSkillNames: Set<string>
    sentDynamicSkillNames: Set<string>
}

export function createSkillRuntimeState(): SkillRuntimeState {
    return {
        checkedSkillDirs: new Set(),
        dynamicSkills: new Map(),
        conditionalSkills: new Map(),
        activatedConditionalSkillNames: new Set(),
        sentDynamicSkillNames: new Set(),
    }
}



// Agent section
export type {
    AgentDefinition,
    AgentDefinitionsResult,
    AgentSource,
}

// AppState section 
export type AppState = {
    toolPermissionContext: ToolPermissionContext
}

export function getEmptyToolPermissionContext(): ToolPermissionContext {
    return {
        mode: 'default',
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
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
    additionalWorkingDirectories: Map<string, { path: string; source: PermissionRuleSource }>
    alwaysAllowRules: ToolPermissionRulesBySource
    alwaysDenyRules: ToolPermissionRulesBySource
    alwaysAskRules: ToolPermissionRulesBySource
}
