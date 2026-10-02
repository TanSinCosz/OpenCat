import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import {
  getAppConfig, getConfigCliOptions, getConfigValue, loadAppConfig, loadConfig,
  parseAppConfig, stripConfigCliOptions, withAppConfig,
} from "../src/config/load-config.js";

function withYaml(document: unknown, action: (configPath: string, cwd: string) => void): void {
  const cwd = mkdtempSync(path.join(tmpdir(), "opencat-yaml-"));
  const configPath = path.join(cwd, "config.yaml");
  try { writeFileSync(configPath, stringify(document)); action(configPath, cwd); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("one YAML loads model, memory, compression, web, workspace, and evaluation settings", () => {
  withYaml({
    model: { provider: "ark", apiKey: "yaml-secret", model: "endpoint-id", headers: { "X-Project": "opencat" } },
    memory: { autoExtract: false, directory: "memory", embedding: { model: "text-embedding-v4", dimensions: 1024 } },
    compression: { autoCompressTriggerTokens: 4096, bulkyToolResultKeepRecent: 0 },
    reasoning: { continuationRounds: 3 }, web: { port: 6000 }, session: { resume: false },
    tools: { ripgrepPath: "/usr/bin/rg", webSearch: { baseUrl: "https://search.example" } },
    workspace: { sweWorkspaceDir: "worktrees" },
    evaluation: { active: "serial", serial: { limit: 5, phases: ["fix"], allowNetworkClone: false } },
  }, (configPath) => {
    const config = loadAppConfig({ configPath });
    assert.equal(config.model.provider, "volcengine");
    assert.equal(config.model.apiKey, "yaml-secret");
    assert.equal(config.model.maxTokens, 32768);
    assert.deepEqual(config.model.headers, { "X-Project": "opencat" });
    assert.equal(config.memory.autoExtract, false);
    assert.equal(config.compression.autoCompressTriggerTokens, 4096);
    assert.equal(getConfigValue("compression.bulkyToolResultKeepRecent", config), "0");
    assert.equal(getConfigValue("session.resume", config), "false");
    assert.equal(getConfigValue("evaluation.serial.phases", config), "fix");
    assert.equal(config.web.port, 6000);
    assert.equal(config.configPath, configPath);
  });
});

test("application environment variables do not override YAML", () => {
  const saved = { key: process.env.DEEPSEEK_API_KEY, model: process.env.OPENCAT_MODEL, port: process.env.OPENCAT_WEB_PORT, profile: process.env.OPENCAT_MODEL_PROFILE };
  try {
    process.env.DEEPSEEK_API_KEY = "environment-secret";
    process.env.OPENCAT_MODEL = "environment-model";
    process.env.OPENCAT_WEB_PORT = "9999";
    process.env.OPENCAT_MODEL_PROFILE = "missing-profile";
    withYaml({ model: { apiKey: "yaml-key", model: "yaml-model" }, web: { port: 6001 } }, (configPath) => {
      const config = loadAppConfig({ configPath });
      assert.equal(config.model.apiKey, "yaml-key");
      assert.equal(config.model.model, "yaml-model");
      assert.equal(config.web.port, 6001);
    });
  } finally {
    for (const [name, value] of Object.entries({
      DEEPSEEK_API_KEY: saved.key, OPENCAT_MODEL: saved.model, OPENCAT_WEB_PORT: saved.port, OPENCAT_MODEL_PROFILE: saved.profile,
    })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("named profiles are selected from YAML or explicit arguments", () => {
  withYaml({ activeProfile: "deepseek", profiles: {
    deepseek: { provider: "deepseek", apiKey: "deepseek-key" },
    ark: { provider: "ark", apiKey: "ark-key", model: "endpoint" },
  } }, (configPath) => {
    assert.equal(loadAppConfig({ configPath }).model.profileName, "deepseek");
    assert.equal(loadConfig({ configPath, profile: "ark" }).apiKey, "ark-key");
    assert.equal(loadConfig({ configPath, profile: "ark" }).provider, "volcengine");
  });
});

test("a single named profile is selected automatically", () => {
  assert.equal(parseAppConfig({ profiles: { custom: { provider: "openai-compatible", apiKey: "key", model: "custom" } } }).model.profileName, "custom");
});

test("project YAML is discovered and explicit paths are relative to startup cwd", () => {
  withYaml({ model: { model: "explicit" } }, (configPath, cwd) => {
    mkdirSync(path.join(cwd, ".opencat"));
    writeFileSync(path.join(cwd, ".opencat", "config.yaml"), "model:\n  model: project\n");
    assert.equal(loadAppConfig({ cwd }).model.model, "project");
    assert.equal(loadAppConfig({ cwd, configPath: "config.yaml" }).model.model, "explicit");
    assert.equal(loadAppConfig({ cwd, configPath: "config.yaml" }).configPath, configPath);
  });
});

test("explicit missing YAML files and malformed YAML fail clearly", () => {
  withYaml({}, (configPath, cwd) => {
    assert.throws(() => loadAppConfig({ cwd, configPath: "missing.yaml" }), /Unable to load OpenCat YAML config/);
    writeFileSync(configPath, "model: [broken");
    assert.throws(() => loadAppConfig({ configPath }), /Unable to load OpenCat YAML config/);
  });
});

test("invalid and unknown YAML fields fail with their field path", () => {
  for (const [document, expected] of [
    [{ web: { port: "5177" } }, /web.port/],
    [{ web: { port: 65536 } }, /web.port/],
    [{ memory: { autoExtract: "false" } }, /memory.autoExtract/],
    [{ compression: { autoCompressTriggerTokens: -1 } }, /compression.autoCompressTriggerTokens/],
    [{ model: { maxTokens: 1.5 } }, /model.maxTokens/],
    [{ model: { apiKeyEnv: "DEEPSEEK_API_KEY" } }, /apiKeyEnv/],
    [{ memory: { embedding: { dimensions: 0 } } }, /dimensions/],
    [{ reasoning: { continuatonRounds: 2 } }, /continuatonRounds/],
  ] as const) assert.throws(() => parseAppConfig(document), expected);
});

test("ambiguous profiles and unknown profile selections fail", () => {
  assert.throws(() => parseAppConfig({ profiles: { a: {}, b: {} } }), /activeProfile/);
  assert.throws(() => parseAppConfig({ model: {}, profiles: { a: {} } }), /either model or profiles/);
  assert.throws(() => parseAppConfig({ activeProfile: "missing", profiles: { a: {} } }), /Unknown model profile/);
});

test("CLI config selectors support both syntaxes and are removed from the prompt", () => {
  assert.deepEqual(getConfigCliOptions(["--config", "local.yaml", "--profile=ark"]), { configPath: "local.yaml", profile: "ark" });
  assert.deepEqual(stripConfigCliOptions(["--config=local.yaml", "--profile", "ark", "fix", "bug"]), ["fix", "bug"]);
  assert.throws(() => getConfigCliOptions(["--config"]), /requires a value/);
});

test("concurrent configuration scopes do not leak between runs", async () => {
  const a = parseAppConfig({ web: { port: 6001 } });
  const b = parseAppConfig({ web: { port: 6002 } });
  const results = await Promise.all([
    withAppConfig(a, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return getAppConfig().web.port; }),
    withAppConfig(b, async () => { await Promise.resolve(); return getAppConfig().web.port; }),
  ]);
  assert.deepEqual(results, [6001, 6002]);
});
