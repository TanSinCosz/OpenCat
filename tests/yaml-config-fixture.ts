import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { stringify } from "yaml";
import { initializeAppConfig } from "../src/config/load-config.js";

/** Existing algorithm tests vary numeric YAML fields through a real config file. */
export function createYamlConfigValues(): Record<string, string | undefined> {
  const directory = mkdtempSync(join(tmpdir(), "opencat-config-fixture-"));
  const configPath = join(directory, "config.yaml");
  const values: Record<string, string | undefined> = {};
  function publish(): void {
    const document: Record<string, any> = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const keys = field.split(".");
      let target = document;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys.at(-1)!] = Number(value);
    }
    writeFileSync(configPath, stringify(document));
    initializeAppConfig({ configPath });
  }
  publish();
  after(() => rmSync(directory, { recursive: true, force: true }));
  return new Proxy(values, {
    set(target, field: string, value: string | undefined) { target[field] = value; publish(); return true; },
    deleteProperty(target, field: string) { delete target[field]; publish(); return true; },
  });
}
