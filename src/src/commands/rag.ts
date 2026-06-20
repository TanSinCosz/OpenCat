import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'

function buildRagPrompt(question: string): string {
  if (!question.trim()) {
    return [
      'The user invoked /rag without a question.',
      'Ask the user to provide a concrete question, for example: /rag How does authentication work in this project?',
    ].join('\n')
  }

  return [
    'You are running a retrieval-augmented generation pipeline for the user.',
    '',
    'User question:',
    question.trim(),
    '',
    'Follow this chain end to end:',
    '',
    '1. Retrieve context',
    '- First look for any dedicated RAG, retrieval, search, memory, vector, or MCP tools that are available in this session. Use them if they fit the question.',
    '- If no dedicated RAG tool exists, retrieve from the local project using the available file search and read tools.',
    '- Gather enough concrete context to answer, including file paths, symbols, configuration, docs, or command outputs when relevant.',
    '',
    '2. Generate grounded content',
    '- Answer only from retrieved evidence and clearly marked inference.',
    '- Do not invent APIs, files, or behavior that you did not verify.',
    '- If the retrieved context is insufficient, say what is missing and give the best bounded answer.',
    '',
    '3. Output',
    '- Start with the direct answer.',
    '- Include concise evidence references such as file paths, symbols, or tool/source names.',
    '- End with any remaining gaps or next steps only if they matter.',
  ].join('\n')
}

const rag: Command = {
  type: 'prompt',
  name: 'rag',
  aliases: ['ask-rag'],
  description: 'Answer a question with a retrieval-augmented generation flow',
  argumentHint: '<question>',
  progressMessage: 'running RAG',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    return [{ type: 'text', text: buildRagPrompt(args) }]
  },
}

export default rag
