import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileEdit } from "../src/Tools/FileEdit/FileEdit.js";
import { FileRead } from "../src/Tools/FileRead/FileRead.js";
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

test("Read refreshes partial-view cache instead of returning file unchanged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-edit-"));
  const filePath = join(cwd, "partial-refresh.txt");
  await writeFile(filePath, "before\n", "utf8");

  const context = createToolUseContext();
  context.readFileState.set(filePath, {
    content: "before\n",
    timestamp: Math.floor((await stat(filePath)).mtimeMs),
    offset: 1,
    limit: undefined,
    isPartialView: true,
  });

  const read = new FileRead();
  const readOutput = await read.call({ file_path: filePath }, context);

  assert.equal(readOutput.type, "text");
  assert.equal(context.readFileState.get(filePath)?.isPartialView, undefined);
  assert.equal(context.readFileState.get(filePath)?.offset, undefined);
  assert.equal(context.readFileState.get(filePath)?.limit, undefined);

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
});

test("Read stores default full-file reads with undefined offset and limit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-read-"));
  const filePath = join(cwd, "full-read.txt");
  await writeFile(filePath, "one\ntwo\n", "utf8");

  const context = createToolUseContext();
  const read = new FileRead();

  const first = await read.call({ file_path: filePath }, context);
  const cacheEntry = context.readFileState.get(filePath);
  const second = await read.call({ file_path: filePath }, context);

  assert.equal(first.type, "text");
  assert.equal(cacheEntry?.offset, undefined);
  assert.equal(cacheEntry?.limit, undefined);
  assert.equal(second.type, "file_unchanged");
});

test("Read preserves explicit range reads in cache", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "opencat-file-read-"));
  const filePath = join(cwd, "range-read.txt");
  await writeFile(filePath, "one\ntwo\nthree\n", "utf8");

  const context = createToolUseContext();
  const read = new FileRead();

  const output = await read.call(
    { file_path: filePath, offset: 2, limit: 1 },
    context,
  );
  const cacheEntry = context.readFileState.get(filePath);

  assert.equal(output.type, "text");
  assert.equal(cacheEntry?.offset, 2);
  assert.equal(cacheEntry?.limit, 1);
});
