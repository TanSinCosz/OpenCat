const MAX_SECTION_TOKENS = 2_000;
const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000;

export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`.trim();

export const SESSION_MEMORY_SYSTEM_PROMPT =
  [
    "You are a forked session-memory agent.",
    "Your only task is to update the session memory notes file using the Edit tool.",
    "Do not call tools other than Edit. Stop after the edit is complete.",
  ].join(" ");

/**
 * Builds the model-visible instruction for refreshing session memory.
 *
 * Session memory is a rolling markdown notes file with a fixed set of sections.
 * Each update should rewrite content inside those sections, not append a new
 * section per summary run. Keeping the structure stable makes later
 * autocompress projections easier to reason about and friendlier to cache.
 */
export function buildSessionMemoryUpdatePrompt(input: {
  currentNotes: string;
  notesPath?: string;
}): string {
  const currentNotes = input.currentNotes.trim() ||
    DEFAULT_SESSION_MEMORY_TEMPLATE;
  const sectionReminders = buildSectionReminders(currentNotes);
  const conversationSource =
    "Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, project instructions, dynamic context, or any past session summaries), update the session notes markdown.";

  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

${conversationSource}

The current session notes are:
<current_notes_content>
${currentNotes}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the session notes file, then stop. The file path is:
${input.notesPath ?? "<session-memory-notes-file>"}

The file has already been read for you. Use old_string/new_string replacements against that file. Do not return the full markdown as a normal assistant message.

CRITICAL RULES:
- Preserve the exact structure with all sections, headers, and italic descriptions intact.
- NEVER modify, delete, or add section headers.
- NEVER modify or delete the italic section description lines immediately following each header.
- ONLY update actual content below the italic descriptions within each existing section.
- Do NOT add any new sections, summaries, or information outside the existing structure.
- Do NOT reference this note-taking process or instructions anywhere in the notes.
- It is OK to skip updating a section if there are no substantial new insights.
- Write detailed, info-dense content with concrete file paths, function names, commands, errors, and decisions.
- Always update "Current State" to reflect the most recent work.
- For "Key results", include complete exact outputs the user requested when applicable.
- Keep each section under about ${MAX_SECTION_TOKENS} tokens by condensing older or lower-value details.
- Use the Edit tool with file_path exactly equal to the path above.
${sectionReminders}`;
}

/**
 * Returns true when the notes have not accumulated real session knowledge yet.
 * Autocompress can use this to decide whether session memory is usable as a
 * compact summary or whether it should fall back to another compression path.
 */
export function isSessionMemoryEmpty(content: string): boolean {
  return content.trim() === "" ||
    content.trim() === DEFAULT_SESSION_MEMORY_TEMPLATE;
}

/**
 * Produces a compact-safe version of the session memory markdown.
 *
 * This preserves the fixed section structure, but trims oversized section
 * bodies so the notes themselves cannot consume the whole post-compact budget.
 */
export function truncateSessionMemoryForCompact(content: string): {
  truncatedContent: string;
  wasTruncated: boolean;
} {
  const lines = content.split("\n");
  const maxCharsPerSection = MAX_SECTION_TOKENS * 4;
  const outputLines: string[] = [];
  let sectionHeader = "";
  let sectionLines: string[] = [];
  let wasTruncated = false;

  for (const line of lines) {
    if (line.startsWith("# ")) {
      const flushed = flushSection(sectionHeader, sectionLines, maxCharsPerSection);
      outputLines.push(...flushed.lines);
      wasTruncated = wasTruncated || flushed.wasTruncated;
      sectionHeader = line;
      sectionLines = [];
    } else {
      sectionLines.push(line);
    }
  }

  const flushed = flushSection(sectionHeader, sectionLines, maxCharsPerSection);
  outputLines.push(...flushed.lines);
  wasTruncated = wasTruncated || flushed.wasTruncated;

  return {
    truncatedContent: outputLines.join("\n"),
    wasTruncated,
  };
}

/**
 * Adds extra instructions when the existing notes are getting too large.
 * The reminder is included in the next update prompt so the model can condense
 * older details while preserving the fixed section layout.
 */
function buildSectionReminders(content: string): string {
  const sectionSizes = analyzeSectionSizes(content);
  const totalTokens = roughTokenCountEstimation(content);
  const overBudget = totalTokens > MAX_TOTAL_SESSION_MEMORY_TOKENS;
  const oversized = Object.entries(sectionSizes)
    .filter(([, tokens]) => tokens > MAX_SECTION_TOKENS)
    .sort(([, a], [, b]) => b - a)
    .map(
      ([section, tokens]) =>
        `- "${section}" is about ${tokens} tokens (limit: ${MAX_SECTION_TOKENS})`,
    );

  if (!overBudget && oversized.length === 0) {
    return "";
  }

  const reminders: string[] = [];
  if (overBudget) {
    reminders.push(
      `\nCRITICAL: The session memory is about ${totalTokens} tokens, above the ${MAX_TOTAL_SESSION_MEMORY_TOKENS} token budget. Condense it aggressively while preserving Current State and Errors & Corrections.`,
    );
  }

  if (oversized.length > 0) {
    reminders.push(
      `\nOversized sections to condense:\n${oversized.join("\n")}`,
    );
  }

  return reminders.join("\n");
}

/**
 * Splits the markdown notes by top-level section and estimates each section's
 * size. The estimate is intentionally rough because it is only used for
 * budget guidance, not exact provider token accounting.
 */
function analyzeSectionSizes(content: string): Record<string, number> {
  const sections: Record<string, number> = {};
  const lines = content.split("\n");
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# ")) {
      if (currentSection) {
        sections[currentSection] = roughTokenCountEstimation(
          currentContent.join("\n").trim(),
        );
      }
      currentSection = line;
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections[currentSection] = roughTokenCountEstimation(
      currentContent.join("\n").trim(),
    );
  }

  return sections;
}

/**
 * Flushes one markdown section during compact-time truncation.
 * Headers are kept intact; only the section body may be shortened.
 */
function flushSection(
  sectionHeader: string,
  sectionLines: string[],
  maxChars: number,
): { lines: string[]; wasTruncated: boolean } {
  if (!sectionHeader) {
    return { lines: sectionLines, wasTruncated: false };
  }

  const sectionContent = sectionLines.join("\n");
  if (sectionContent.length <= maxChars) {
    return { lines: [sectionHeader, ...sectionLines], wasTruncated: false };
  }

  const keptLines = [sectionHeader];
  let charCount = 0;

  for (const line of sectionLines) {
    if (charCount + line.length + 1 > maxChars) {
      break;
    }

    keptLines.push(line);
    charCount += line.length + 1;
  }

  keptLines.push("\n[... section truncated for length ...]");
  return { lines: keptLines, wasTruncated: true };
}

/**
 * Cheap token estimate used for session-memory thresholds and section warnings.
 */
function roughTokenCountEstimation(content: string): number {
  return Math.ceil(content.length / 4);
}
