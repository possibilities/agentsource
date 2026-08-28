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

export interface HerdrPanePresence {
  paneId: string;
  tabId: string;
  workspaceId: string;
  title: string | null;
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
  panes: HerdrPanePresence[];
  ci: CiSummary | null;
}

export interface ProjectStatus {
  name: string;
  path: string;
  displayPath: string;
  primaryBranch: string | null;
  primaryHead: string | null;
  primaryWorking: WorkingStats;
  unpushed: UnpushedStats;
  agents: AgentPresence[];
  panes: HerdrPanePresence[];
  worktrees: WorktreeStatus[];
  issues: string[];
  primaryCi: CiSummary | null;
}

export interface CiObservation {
  available: boolean;
  projections: CiProjection[];
  diagnostics: string[];
}

export interface ScanResult {
  root: string;
  projects: ProjectStatus[];
  agentPresence: AgentPresenceObservation;
  ci: CiObservation;
  diagnostics: string[];
  scannedAt: Date;
}

export const OBSERVATION_SCHEMA_VERSION = 3 as const;

/** Stable machine-readable form of a point-in-time scan. */
export interface SerializedObservation {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  scannedAt: string;
  root: string;
  projects: ProjectStatus[];
  agentPresence: AgentPresenceObservation;
  ci: CiObservation;
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

export interface ChannelSnapshotRequest {
  schemaVersion: typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;
  requestId: string;
  method: "snapshot";
  channels: string[];
}

/** One value emitted on a subscribed Unix-socket channel. */
export interface ChannelEnvelope<T = unknown> {
  schemaVersion: typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;
  channel: string;
  emittedAt: string;
  data: T;
}

export interface ChannelSnapshotResponse {
  schemaVersion: typeof CHANNEL_PROTOCOL_SCHEMA_VERSION;
  requestId: string;
  ok: true;
  values: ChannelEnvelope[];
}

export const CI_PROJECTION_SCHEMA_VERSION = 2 as const;

export type CiAggregateState =
  | "ERROR"
  | "EXPECTED"
  | "FAILURE"
  | "PENDING"
  | "SUCCESS"
  | "NONE"
  | "LOCAL"
  | "UNAVAILABLE";

export type CiState = "PASS" | "PENDING" | "FAIL" | "NONE" | "LOCAL" | "UNKNOWN";

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

export interface CiHead {
  sha: string;
  committedAt: string | null;
  aggregateState: CiAggregateState;
  contexts: CiContext[];
  diagnostics: string[];
}

export interface CiBranchTarget {
  kind: "branch";
  branch: string;
  role: "primary" | "default";
  headSha: string | null;
}

export interface CiCheckoutTarget {
  kind: "checkout";
  path: string;
  branch: string | null;
  headSha: string;
}

export type CiTarget = CiBranchTarget | CiCheckoutTarget;

export interface CiSummary {
  channel: string;
  state: CiState;
  headSha: string | null;
  aggregateState: CiAggregateState | null;
}

/** Complete current CI state for one registered project's relevant Git heads. */
export interface CiProjection {
  schemaVersion: typeof CI_PROJECTION_SCHEMA_VERSION;
  revision: number;
  projectedAt: string;
  owner: string;
  repo: string;
  paths: string[];
  available: boolean;
  defaultBranch: string | null;
  primaryBranch: string;
  heads: CiHead[];
  targets: CiTarget[];
  diagnostics: string[];
}
