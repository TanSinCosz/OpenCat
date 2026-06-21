import { readFile } from "node:fs/promises";

const defaultName = "Tree-sitter";

export function greet(name = defaultName) {
  return `Hello, ${name}!`;
}

async function loadMessage(path) {
  const content = await readFile(path, "utf8");
  return content.trim();
}

console.log(greet());
loadMessage("./message.txt").then(console.log);
