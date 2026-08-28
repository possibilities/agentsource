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

export const CHANNEL_PROTOCOL_SCHEMA_VERSION = 1 as const;

/** The one request a Unix-socket client sends before receiving channel values. */
export interface ChannelSubscription {
  schemaVersion: typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;
  subscribe: string[];
}

/** One value emitted on a subscribed Unix-socket channel. */
export interface ChannelEnvelope<T = unknown> {
  schemaVersion: typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;
  channel: string;
  emittedAt: string;
  data: T;
}

export const CI_PROJECTION_SCHEMA_VERSION = 1 as const;

export type CiAggregateState =
  | "ERROR"
  | "EXPECTED"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS"
  | "NONE"
  | "UNAVAILABLE";

export interface CiCheckRun {
  kind: "check-run";
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  app: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CiStatusContext {
  kind: "status";
  name: string;
  state: string;
  description: string | null;
  targetUrl: string | null;
  createdAt: string | null;
}

export type CiContext = CiCheckRun | CiStatusContext;

/** Complete current CI state for one registered project's default-branch HEAD. */
export interface CiProjection {
  schemaVersion: typeof CI_PROJECTION_SCHEMA_VERSION;
  revision: number;
  projectedAt: string;
  owner: string;
  repo: string;
  paths: string[];
  available: boolean;
  defaultBranch: string | null;
  headSha: string | null;
  headCommittedAt: string | null;
  aggregateState: CiAggregateState;
  contexts: CiContext[];
  diagnostics: string[];
}
