import { z } from "zod";

const text = z.string().trim();
const positive = z.number().int().positive();
const nonNegative = z.number().int().nonnegative();
const strings = z.record(z.string(), z.string());
const section = <T extends z.ZodRawShape>(shape: T) => {
  const schema = z.strictObject(shape);
  return schema.prefault({} as z.input<typeof schema>);
};

export const modelSchema = z.strictObject({
  provider: z.enum(["deepseek", "volcengine", "ark", "openai-compatible"]).optional(),
  apiKey: text.optional(), baseUrl: text.optional(), model: text.optional(),
  maxTokens: positive.optional(), userId: text.optional(), headers: strings.optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
});
const service = z.strictObject({
  apiKey: text.optional(), baseUrl: text.optional(), model: text.optional(), dimensions: positive.optional(),
});
const evaluation = z.strictObject({
  runId: text.optional(), runPrefix: text.optional(), datasetPath: text.optional(),
  autoPrepareDataset: z.boolean().optional(),
  datasetSource: text.optional(), datasetSplit: text.optional(), outputDir: text.optional(),
  reposDir: text.optional(), workspaceRoot: text.optional(), repoCacheRoot: text.optional(),
  limit: positive.optional(), model: text.optional(), allowNetworkClone: z.boolean().optional(),
  allowWebTools: z.boolean().optional(), allowDirtyWorkspaces: z.boolean().optional(),
  workspaceNamespace: text.optional(), concurrency: positive.optional(),
  phases: z.array(z.enum(["investigate", "fix"])).optional(), userRounds: positive.optional(),
  version: text.optional(), evalVersion: text.optional(), python: text.optional(),
  contextCompression: z.strictObject({
    enableProjection: z.boolean().optional(), autoCompressTriggerTokens: positive.optional(),
  }).optional(),
});
const probe = z.strictObject({
  model: text.optional(), maxTokens: positive.optional(), pauseMs: nonNegative.optional(),
  runId: text.optional(), rounds: positive.optional(), prefixLines: nonNegative.optional(),
  toolLines: positive.optional(), toolChoice: z.enum(["auto", "none", "required"]).optional(),
  firstMaxTokens: positive.optional(), secondMaxTokens: positive.optional(),
});

/** The complete YAML contract. Unknown keys and invalid values fail at startup. */
export const appConfigSchema = z.strictObject({
  activeProfile: text.optional(), profiles: z.record(z.string(), modelSchema).optional(), model: modelSchema.optional(),
  memory: section({
    enabled: z.boolean().default(true), autoInject: z.boolean().default(true), autoExtract: z.boolean().default(true),
    autoInjectTopK: positive.default(6), searchThreshold: z.number().min(0).max(1).default(0.1),
    maxInjectedChars: positive.default(40_000), directory: text.optional(), userId: text.default("default-user"),
    dreamRecentSessions: positive.default(8), embedding: service.prefault({}), llm: service.prefault({}),
    vectorStore: section({ dbPath: text.optional(), dimensions: positive.optional() }),
  }),
  compression: section({
    autoCompressTriggerTokens: positive.default(180_000), snippedContentAutoCompressTriggerTokens: positive.optional(),
    historySnipTargetTokens: positive.optional(), historySnipMinRecentMessages: nonNegative.optional(),
    historySnipCancelContextTokens: positive.optional(), bulkyToolResultCompactContextTokens: positive.optional(),
    bulkyToolResultCompactTargetContextTokens: positive.optional(), bulkyToolResultKeepRecent: nonNegative.optional(),
    recentTailTargetTokens: positive.optional(), recentTailMaxTokens: positive.optional(),
    recentTailMinApiMessages: nonNegative.optional(), recentTailMinUserContentMessages: nonNegative.optional(),
  }),
  reasoning: section({ continuationRounds: positive.default(2), continuationMaxTokens: positive.optional(), finalMaxTokens: positive.optional() }),
  session: section({ id: text.optional(), resume: z.boolean().default(true), transcriptHydrate: z.enum(["auto", "full"]).default("auto") }),
  web: section({ port: positive.max(65535).default(5177), url: text.default("http://localhost:5177") }),
  tools: section({
    ripgrepPath: text.optional(),
    webSearch: section({ apiKey: text.optional(), model: text.optional(), baseUrl: text.optional(), messagesUrl: text.optional() }),
  }),
  workspace: section({ patchSnapshotDir: text.optional(), sweWorkspaceDir: text.optional(), sweRepoCacheDir: text.optional() }),
  mcp: section({
    stdio: z.array(z.strictObject({
      name: text.min(1), command: text.min(1), args: z.array(z.string()).optional(), cwd: text.optional(), env: strings.optional(),
    })).default([]),
    http: z.array(z.strictObject({
      name: text.min(1), url: z.string().url(), headers: strings.optional(),
      auth: z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("none") }), z.strictObject({ type: z.literal("bearer"), token: z.string() }),
      ]).optional(),
    })).default([]),
  }),
  evaluation: section({
    active: z.enum(["serial", "verified"]).default("verified"),
    directory: text.optional(), patchDirectory: text.optional(), dashboardPort: positive.max(65535).default(5188),
    serial: evaluation.prefault({}), verified: evaluation.prefault({}),
  }),
  experiments: section({
    betaBaseUrl: text.optional(),
    abaCache: probe.pick({ maxTokens: true, pauseMs: true, prefixLines: true, runId: true }).prefault({}),
    agentCache: probe.pick({ model: true, maxTokens: true, pauseMs: true, runId: true }).prefault({}),
    cacheEditing: probe.pick({ maxTokens: true, pauseMs: true, toolLines: true, runId: true }).prefault({}),
    cacheField: probe.pick({ pauseMs: true, runId: true }).prefault({}),
    cacheOrder: probe.pick({ rounds: true, pauseMs: true, toolChoice: true, runId: true }).prefault({}),
    prefixReasoning: probe.pick({ model: true, firstMaxTokens: true, secondMaxTokens: true }).prefault({}),
    userIdCache: probe.pick({ maxTokens: true }).prefault({}),
  }),
});
export type ParsedAppConfig = z.infer<typeof appConfigSchema>;
