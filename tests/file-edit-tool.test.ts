import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileEdit } from "../src/Tools/FileEdit/FileEdit.js";
import { createToolUseContext } from "../src/Tools/types.js";

test("Edit rejects partial-view read cache entries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-edit-"));
  const filePath = join(cwd, "partial-view.txt");
  await writeFile(filePath, "before\n", "utf8");

  const context = createToolUseContext();
  context.readFileState.set(filePath, {
    content: "before\n",
    timestamp: Math.floor((await stat(filePath)).mtimeMs),
    offset: undefined,
    limit: undefined,
    isPartialView: true,
  });

  const edit = new FileEdit();
  const validation = await edit.validateInput(
    {
      file_path: filePath,
      old_string: "before",
      new_string: "after",
      replace_all: false,
    },
    context,
  );

  assert.equal(validation.result, false);
  assert.match(validation.message, /read it first/i);
  assert.equal(await readFile(filePath, "utf8"), "before\n");
});

test("Edit updates read cache after a full read cache entry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-edit-"));
  const filePath = join(cwd, "full-read.txt");
  await writeFile(filePath, "before\n", "utf8");

  const context = createToolUseContext();
  context.readFileState.set(filePath, {
    content: "before\n",
    timestamp: Math.floor((await stat(filePath)).mtimeMs),
    offset: undefined,
    limit: undefined,
  });

  const edit = new FileEdit();
  const output = await edit.call(
    {
      file_path: filePath,
      old_string: "before",
      new_string: "after",
      replace_all: false,
    },
    context,
  );

  assert.equal(output.filePath, filePath);
  assert.equal(await readFile(filePath, "utf8"), "after\n");

  const cacheEntry = context.readFileState.get(filePath);
  assert.equal(cacheEntry?.content, "after\n");
  assert.equal(cacheEntry?.offset, undefined);
  assert.equal(cacheEntry?.limit, undefined);
  assert.equal(cacheEntry?.isPartialView, undefined);
});
