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

export interface WorktreeStatus {
  path: string;
  displayPath: string;
  branch: string | null;
  head: string;
  dirtyFiles: number;
  ahead: number | null;
  behind: number | null;
  mergeState: MergeState;
  issue: string | null;
}

export interface ProjectStatus {
  name: string;
  path: string;
  displayPath: string;
  primaryBranch: string | null;
  working: WorkingStats;
  unpushed: UnpushedStats;
  worktrees: WorktreeStatus[];
  issues: string[];
}

export interface ScanResult {
  root: string;
  projects: ProjectStatus[];
  diagnostics: string[];
  scannedAt: Date;
}

export const OBSERVATION_SCHEMA_VERSION = 1 as const;

/** Stable machine-readable form of a point-in-time scan. */
export interface SerializedObservation {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  scannedAt: string;
  root: string;
  projects: ProjectStatus[];
  diagnostics: string[];
}
