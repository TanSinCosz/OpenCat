import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, "..", "samples", "hello.js");
const source = await readFile(samplePath, "utf8");

const parser = new Parser();
parser.setLanguage(JavaScript);

const tree = parser.parse(source);
const root = tree.rootNode;

console.log("root:", root.type);
console.log("\nAST:");
console.log(formatTree(root));

console.log("\nFunctions:");
for (const node of walk(root)) {
  if (node.type !== "function_declaration") continue;

  const nameNode = node.childForFieldName("name");
  console.log(`- ${nameNode?.text ?? "<anonymous>"} ${formatLocation(node)}`);
}

function* walk(node) {
  yield node;

  for (const child of node.namedChildren) {
    yield* walk(child);
  }
}

function formatTree(node, depth = 0) {
  const indent = "  ".repeat(depth);
  const leafText = node.namedChildCount === 0 ? ` ${JSON.stringify(compactText(node.text))}` : "";
  const currentLine = `${indent}${node.type} ${formatLocation(node)}${leafText}`;
  const childLines = node.namedChildren.map((child) => formatTree(child, depth + 1));

  return [currentLine, ...childLines].join("\n");
}

function formatLocation(node) {
  return `[${node.startPosition.row + 1}:${node.startPosition.column + 1}-${node.endPosition.row + 1}:${node.endPosition.column + 1}]`;
}

function compactText(text) {
  const compacted = text.replaceAll(/\s+/g, " ");
  return compacted.length > 60 ? `${compacted.slice(0, 57)}...` : compacted;
}
