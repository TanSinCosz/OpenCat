/** Web 层共享的数据契约；业务状态仍由核心 State / Runtime 持有。 */
import type { Runtime } from "../../types/runtime.js";
import type { State } from "../../types/state.js";
import type { ToolApprovalDecision } from "../../query/types.js";
import type { WorkspacePatchBaseline } from "../../workspace/patch-snapshot.js";
import type { SweWorkspaceStatusValue } from "../../swe/workspace.js";

export type TranscriptHydrationMode = "auto" | "full";

export interface WebCliSession {
  runtime: Runtime;
  state: State;
  sweDatasetDir: string;
  busy: boolean;
  clientAttached: boolean;
  activeQueryAbortController?: AbortController;
  loadInfo: WebCliSessionLoadInfo;
  pendingToolApprovals: Map<string, PendingToolApproval>;
  patchBaseline?: WorkspacePatchBaseline;
}

export interface PendingToolApproval {
  resolve: (decision: ToolApprovalDecision) => void;
  timeout: NodeJS.Timeout;
}

export interface WebCliSessionLoadInfo {
  restored: boolean;
  requestedSessionId?: string;
  transcriptPath?: string;
  hydrate: TranscriptHydrationMode;
  messageCount: number;
}

export interface WebCliTranscriptSummary {
  sessionId: string;
  modifiedAt: number;
  size: number;
  category: WebCliTranscriptCategory;
}

export type WebCliTranscriptCategory = "general" | "swe" | "swe_serial";

export interface SweBenchItem {
  instanceId: string;
  repo: string;
  baseCommit: string;
  problemPreview: string;
  sessionId: string;
  hasSession: boolean;
  workspaceStatus: SweWorkspaceStatusValue;
}

export interface SweBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  test_patch?: string;
}

export type SweDraftKind = "investigate" | "fix" | "standard";

export interface CreateWebCliSessionOptions {
  sessionId?: string;
  resume: boolean;
  cwd?: string;
  sweDatasetDir?: string;
}
