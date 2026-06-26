import { lemmatizeForBm25CN } from "./lemmatizeCN.js";
import { lemmatizeForBm25 as lemmatizeForBm25English } from "./lemmatizeEng.js";

function hasHan(text: string): boolean {
  return /\p{Script=Han}/u.test(text);
}

function splitTokens(text: string): string[] {
  return text.split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

/**
 * BM25 normalization used by memory indexing and query-time keyword search.
 *
 * English still uses the existing stemmer path. Chinese and mixed-language text
 * additionally goes through Jieba so contiguous Han text is indexed as words
 * instead of one unmatchable character run or an empty English token list.
 */
export function lemmatizeForBm25(text: string): string {
  const englishTokens = splitTokens(lemmatizeForBm25English(text));

  if (!hasHan(text)) {
    return englishTokens.join(" ");
  }

  const chineseTokens = splitTokens(lemmatizeForBm25CN(text));
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const token of [...englishTokens, ...chineseTokens]) {
    const key = token.toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(key);
  }

  return merged.join(" ");
}
