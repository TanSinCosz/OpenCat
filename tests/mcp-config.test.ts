import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { loadAppConfig } from "../src/config/load-config.js";

import { loadMcpConfig } from "../src/mcp/config.js";

test("loadMcpConfig reads local stdio server config", async () => {
  const cwd = await mkdir(join(tmpdir(), `opencat-mcp-config-${Date.now()}`), {
    recursive: true,
  });
  assert.ok(cwd);

  const opencatDir = join(cwd, ".opencat");
  await mkdir(opencatDir, { recursive: true });
  await writeFile(
    join(opencatDir, "config.yaml"),
    stringify({
      mcp: { stdio: [{
          name: "codegraph",
          command: "node",
          args: ["vendor/codegraph/dist/bin/codegraph.js", "serve", "--mcp"],
          env: {
            CODEGRAPH_TELEMETRY: "0",
          },
      }] },
    }),
    "utf8",
  );

  const config = loadMcpConfig(cwd, loadAppConfig({ cwd }));

  assert.equal(config.stdio.length, 1);
  assert.equal(config.stdio[0]?.name, "codegraph");
  assert.equal(config.stdio[0]?.command, "node");
  assert.deepEqual(config.stdio[0]?.args, [
    "vendor/codegraph/dist/bin/codegraph.js",
    "serve",
    "--mcp",
  ]);
  assert.equal(config.stdio[0]?.env?.CODEGRAPH_TELEMETRY, "0");
  assert.equal(config.stdio[0]?.cwd, cwd);
});
