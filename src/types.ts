export interface WorkingStats {
  files: number;
  additions: number;
  deletions: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  binary: number;
}

export interface UnpushedStats {
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  binary: number;
}

export type MergeState = "merged" | "unmerged" | "unknown";

export interface AgentPresence {
  agent: string;
  status: string;
  conversation: string | null;
  sessionId: string | null;
  paneId: string;
  tabId: string;
  workspaceId: string;
  focused: boolean;
}

export interface AgentPresenceObservation {
  available: boolean;
  diagnostics: string[];
}

export interface WorktreeStatus {
  path: string;
  displayPath: string;
  branch: string | null;
  head: string;
  working: WorkingStats;
  ahead: number | null;
  behind: number | null;
  mergeState: MergeState;
  issue: string | null;
  agents: AgentPresence[];
}

export interface ProjectStatus {
  name: string;
  path: string;
  displayPath: string;
  primaryBranch: string | null;
  primaryWorking: WorkingStats;
  /** Aggregate working changes across the primary checkout and linked worktrees. */
  working: WorkingStats;
  unpushed: UnpushedStats;
  agents: AgentPresence[];
  worktrees: WorktreeStatus[];
  issues: string[];
}

export interface ScanResult {
  root: string;
  projects: ProjectStatus[];
  agentPresence: AgentPresenceObservation;
  diagnostics: string[];
  scannedAt: Date;
}

export const OBSERVATION_SCHEMA_VERSION = 2 as const;

/** Stable machine-readable form of a point-in-time scan. */
export interface SerializedObservation {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  scannedAt: string;
  root: string;
  projects: ProjectStatus[];
  agentPresence: AgentPresenceObservation;
  diagnostics: string[];
}

export const WEBHOOK_DELIVERY_SCHEMA_VERSION = 1 as const;

/** One authenticated GitHub request broadcast on the local delivery stream. */
export interface WebhookDelivery {
  schemaVersion: typeof WEBHOOK_DELIVERY_SCHEMA_VERSION;
  receivedAt: string;
  owner: string;
  repo: string;
  event: string;
  deliveryId: string;
  hookId: string | null;
  payload: unknown;
}
