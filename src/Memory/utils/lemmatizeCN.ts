import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";
import { Jieba } from "@node-rs/jieba";

const CURRENT_FILE_PATH = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const JIEBA_DICT_PATH = require.resolve("@node-rs/jieba/dict.txt");
const STOP_WORDS_PATH = path.resolve(
  path.dirname(CURRENT_FILE_PATH),
  "cn_hit.txt",
);

let cachedStopWords: Set<string> | null = null;
const jieba = Jieba.withDict(fs.readFileSync(JIEBA_DICT_PATH));

function loadStopWords(): Set<string> {
  if (cachedStopWords) {
    return cachedStopWords;
  }

  const stopWords = new Set<string>();

  try {
    const fileContent = fs.readFileSync(STOP_WORDS_PATH, "utf8");
    for (const line of fileContent.split(/\r?\n/)) {
      const word = line.trim();
      if (!word) {
        continue;
      }
      stopWords.add(word);
    }
  } catch {
    cachedStopWords = stopWords;
    return stopWords;
  }

  cachedStopWords = stopWords;
  return stopWords;
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

function isPunctuationToken(token: string): boolean {
  return /^[\p{P}\p{S}]+$/u.test(token);
}

function isMeaningfulToken(token: string): boolean {
  if (!token) {
    return false;
  }

  if (isPunctuationToken(token)) {
    return false;
  }

  return /[\p{L}\p{N}\p{Script=Han}]/u.test(token);
}

/**
 * Chinese text normalization for BM25 keyword matching.
 *
 * Processing steps:
 * 1. Segment Chinese text with `@node-rs/jieba`.
 * 2. Normalize tokens with lowercase + trim.
 * 3. Remove stop words.
 * 4. Remove punctuation / symbol-only tokens.
 * 5. Return space-joined tokens for BM25 indexing.
 */
export function tokenizeForBm25CN(text: string): string[] {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return [];
  }

  const stopWords = loadStopWords();
  const tokens = jieba.cut(normalizedText, true);
  const filtered: string[] = [];

  for (const token of tokens) {
    const normalizedToken = normalizeToken(token);

    if (!isMeaningfulToken(normalizedToken)) {
      continue;
    }

    if (stopWords.has(normalizedToken)) {
      continue;
    }

    filtered.push(normalizedToken);
  }

  return filtered;
}

export function lemmatizeForBm25CN(text: string): string {
  return tokenizeForBm25CN(text).join(" ");
}
