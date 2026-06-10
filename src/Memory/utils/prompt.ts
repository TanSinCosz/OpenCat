


const PAST_MESSAGE_TRUNCATION_LIMIT = 300;

export function generateAdditiveExtractionPrompt(options: {
    existingMemories?: Array<{ id: string; text: string }>;
    newMessages?: string;
    lastKMessages?: Array<{ role: string; content: string }>;
    customInstructions?: string;
    currentDate?: string;
    observationDate?: string;
}): string {
    const now = new Date().toISOString().split("T")[0];
    const currentDate = options.currentDate ?? now;
    const observationDate = options.observationDate ?? currentDate;

    const sections: string[] = [];

    // Summary — empty for now; callers can extend later
    sections.push("## Summary\n");

    sections.push(
        `## Last k Messages\n${formatConversationHistory(options.lastKMessages)}`,
    );

    // Recently Extracted Memories — empty for now
    sections.push("## Recently Extracted Memories\n[]");

    sections.push(
        `## Existing Memories\n${serializeMemories(options.existingMemories)}`,
    );

    sections.push(`## New Messages\n${options.newMessages ?? "[]"}`);

    sections.push(`## Observation Date\n${observationDate}`);

    sections.push(`## Current Date\n${currentDate}`);

    if (options.customInstructions) {
        sections.push(`## Custom Instructions\n${options.customInstructions}`);
    }

    sections.push("# Output:");

    return sections.join("\n\n");
}


function formatConversationHistory(
  messages?: Array<{ role: string; content: string }>,
): string {
  if (!messages || messages.length === 0) return "";
  let result = "";
  for (const msg of messages) {
    const role = msg.role ?? "";
    const content = msg.content ?? "";
    if (role && content) {
      result += `${role}: ${truncateContent(content)}\n`;
    }
  }
  return result;
}

function truncateContent(
  text: string,
  limit = PAST_MESSAGE_TRUNCATION_LIMIT,
): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + "...";
}


function serializeMemories(
  memories?: Array<{ id: string; text: string }>,
): string {
  return JSON.stringify(memories ?? []);
}