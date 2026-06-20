import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = join(here, "..", "samples", "hello.js");
const queryPath = join(here, "..", "queries", "javascript.scm");

const [source, querySource] = await Promise.all([
  readFile(samplePath, "utf8"),
  readFile(queryPath, "utf8")
]);

const parser = new Parser();
parser.setLanguage(JavaScript);

const tree = parser.parse(source);
const query = new Parser.Query(JavaScript, querySource);
const captures = query.captures(tree.rootNode);

for (const capture of captures) {
  const { name, node } = capture;
  const text = node.text.replaceAll(/\s+/g, " ");

  console.log({
    capture: name,
    text,
    start: node.startPosition,
    end: node.endPosition
  });
}
