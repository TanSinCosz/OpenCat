import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveModelProvider } from "../openai-compatible/provider.js";
import { normalizeModelRuntimeSettings, type ModelRuntimeSettings } from "../types/config.js";
import { appConfigSchema, type ParsedAppConfig } from "./schema.js";

export type AppConfig = Omit<ParsedAppConfig, "model"> & {
  model: ModelRuntimeSettings;
  /** Absolute path of the single YAML source. */
  configPath?: string;
};
export interface LoadAppConfigOptions { cwd?: string; configPath?: string; profile?: string }
const configScope = new AsyncLocalStorage<AppConfig>();
let applicationConfig: AppConfig | undefined;

/** Explicit file > project YAML > user YAML. Files are never merged. */
export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  const cwd = options.cwd ?? process.cwd();
  const configPath = options.configPath ? path.resolve(cwd, options.configPath)
    : [path.join(cwd, ".opencat", "config.yaml"), getUserConfigPath()].find(existsSync);
  let document: unknown = {};
  if (configPath) {
    try { document = parseYaml(readFileSync(configPath, "utf8")) ?? {}; }
    catch (error) { throw new Error(`Unable to load OpenCat YAML config: ${configPath}`, { cause: error }); }
  }
  return parseAppConfig(document, { ...options, configPath });
}

export function parseAppConfig(document: unknown, options: LoadAppConfigOptions = {}): AppConfig {
  const result = appConfigSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid OpenCat YAML config${options.configPath ? ` (${options.configPath})` : ""}: ${details}`);
  }
  const config = result.data;
  const profileName = options.profile ?? config.activeProfile ??
    (config.profiles && Object.keys(config.profiles).length === 1 ? Object.keys(config.profiles)[0] : undefined);
  if (config.profiles && config.model) throw new Error("Choose either model or profiles in YAML, not both");
  if (config.profiles && !profileName) throw new Error("YAML config must select activeProfile when multiple profiles exist");
  if (profileName && !config.profiles?.[profileName]) throw new Error(`Unknown model profile '${profileName}' in YAML config`);
  const selected = (profileName ? config.profiles?.[profileName] : config.model) ?? {};
  const provider = resolveModelProvider({ provider: selected.provider === "ark" ? "volcengine" : selected.provider, baseUrl: selected.baseUrl });
  const model = normalizeModelRuntimeSettings({
    ...selected, profileName, provider, apiKey: selected.apiKey ?? "",
    model: selected.model ?? (provider === "deepseek" ? "deepseek-v4-pro" : ""),
    maxTokens: selected.maxTokens ?? 32_768,
    reasoningEffort: selected.reasoningEffort ?? (provider === "deepseek" ? "max" : undefined),
  });
  return { ...config, model, configPath: options.configPath };
}

/** Entry points initialize once; sessions share the resolved snapshot. */
export function initializeAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  applicationConfig = loadAppConfig(options);
  return applicationConfig;
}
export function getAppConfig(): AppConfig {
  return configScope.getStore() ?? (applicationConfig ??= loadAppConfig(getConfigCliOptions()));
}
/** Isolate runtime/test configuration without changing other sessions. */
export function withAppConfig<T>(config: AppConfig, action: () => T): T { return configScope.run(config, action); }
/** Compatibility for model-only callers; environment variables are never read. */
export function loadConfig(options?: LoadAppConfigOptions): ModelRuntimeSettings {
  return options ? loadAppConfig(options).model : getAppConfig().model;
}
export function getUserConfigPath(): string { return path.join(homedir(), ".opencat", "config.yaml"); }
export function getEvaluationConfig(config = getAppConfig()): AppConfig["evaluation"]["serial"] {
  return config.evaluation[config.evaluation.active];
}

/** Scalar adapter for existing algorithms. Field names are YAML paths. */
export function getConfigValue(field: string, config = getAppConfig()): string | undefined {
  let value: unknown = config;
  for (const key of field.split(".")) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
export function getConfigCliOptions(args = process.argv.slice(2)): LoadAppConfigOptions {
  const options: LoadAppConfigOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const name = argument.split("=", 1)[0];
    if (name !== "--config" && name !== "--profile") continue;
    const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (name === "--config") options.configPath = value; else options.profile = value;
  }
  return options;
}
export function stripConfigCliOptions(args: string[]): string[] {
  getConfigCliOptions(args);
  const remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--config" || argument === "--profile") { index++; continue; }
    if (argument.startsWith("--config=") || argument.startsWith("--profile=")) continue;
    remaining.push(argument);
  }
  return remaining;
}
