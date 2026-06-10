


export function removeCodeBlocks(text: string): string {
  // Extract content inside code fences, handling both complete and
  // truncated blocks (where the closing ``` never arrives).
  const stripped = text
    .replace(/```(?:\w+)?\n?([\s\S]*?)(?:```|$)/g, "$1")
    .trim();
  // Strip <think>...</think> blocks emitted by reasoning models (e.g. DeepSeek)
  return stripped.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}



export function extractJson(text: string): string {
  // Step 1: Strip known noise tokens from OpenRouter/local models
  let cleaned = text
    .replace(/<\|end_of_text\|>/g, "")
    .replace(/<\|eot_id\|>/g, "")
    .replace(/<\|im_end\|>/g, "")
    .replace(/<\|im_start\|>/g, "")
    .replace(/<\|endoftext\|>/g, "");

  // Step 2: Strip code fences and <think> blocks
  cleaned = removeCodeBlocks(cleaned);
  const trimmed = cleaned.trim();

  if (!trimmed) return "";

  // Step 3: Try to find valid JSON object by testing each `{` as potential start
  // This handles cases like "Here's the {formatted} output: {...actual json...}"
  const braceIndices: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "{") braceIndices.push(i);
  }

  for (const start of braceIndices) {
    // Find the matching closing brace by tracking depth
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = start; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.substring(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate; // Valid JSON found
          } catch {
            // Not valid JSON, try next starting brace
            break;
          }
        }
      }
    }
  }

  // Step 4: Fallback - try first/last brace (original behavior for edge cases)
  // Only use this if it produces valid JSON
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const candidate = trimmed.substring(firstBrace, lastBrace + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON, continue to array extraction
    }
  }

  // Step 5: Try to locate a JSON array by testing each `[` as potential start
  const bracketIndices: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "[") bracketIndices.push(i);
  }

  for (const start of bracketIndices) {
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = start; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "[") depth++;
      else if (char === "]") {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.substring(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break;
          }
        }
      }
    }
  }

  // Fallback for arrays - validate before returning
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    const candidate = trimmed.substring(firstBracket, lastBracket + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON
    }
  }

  // No valid JSON found — return as-is and let the caller handle the error
  return trimmed;
}
