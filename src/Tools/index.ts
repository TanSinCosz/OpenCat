import { Agent } from "./Agent/Agent.js";
import {
  createAgentDefinitions,
  type AgentDefinitionsResult,
} from "./Agent/index.js";
import { Bash } from "./Bash/Bash.js";
import { FileEdit } from "./FileEdit/FileEdit.js";
import { FileRead } from "./FileRead/FileRead.js";
import { FileWrite } from "./FileWrite/FileWrite.js";
import { Glob } from "./Glob/Glob.js";
import { Grep } from "./Grep/Grep.js";
import { MemorySave } from "./MemorySave/MemorySave.js";
import { SendMessage } from "./SendMessage/SendMessage.js";
import { WebSearch } from "./WebSearch/WebSearch.js";
import type { Tools } from "./types.js";

export type CreateDefaultToolsOptions = {
  agentDefinitions?: AgentDefinitionsResult;
};

export function createDefaultTools(
  options: CreateDefaultToolsOptions = {},
): Tools {
  const agentDefinitions = options.agentDefinitions ?? createAgentDefinitions();

  return [
    new Agent(agentDefinitions),
    new Bash(),
    new FileRead(),
    new FileWrite(),
    new FileEdit(),
    new Glob(),
    new Grep(),
    new WebSearch(),
    new MemorySave(),
    new SendMessage(),
  ];
}

export {
  Agent,
  Bash,
  FileEdit,
  FileRead,
  FileWrite,
  Glob,
  Grep,
  MemorySave,
  SendMessage,
  WebSearch,
};

export type { Tool, Tools, ToolUseContext } from "./types.js";
