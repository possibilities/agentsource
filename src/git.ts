import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { attachAgentPresence, type HerdrRunner, readHerdrSnapshot, runHerdr } from "./herdr.ts";
import type {
  ProjectStatus,
  ScanResult,
  UnpushedStats,
  WorkingStats,
  WorktreeStatus,
} from "./types.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitResult>;

const EMPTY_WORKING: WorkingStats = {
  files: 0,
  additions: 0,
  deletions: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicts: 0,
  binary: 0,
};

const EMPTY_UNPUSHED: UnpushedStats = {
  commits: 0,
  files: 0,
  additions: 0,
  deletions: 0,
  binary: 0,
};

/** Run Git without a shell. Every caller in this module uses read-only commands. */
export async function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return await new Promise((resolveResult) => {
    const child = spawn("git", ["--no-optional-locks", "-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 15_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code: 127, stdout, stderr: error.message });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({
        code: code ?? 124,
        stdout,
        stderr: signal ? `${stderr}${stderr === "" ? "" : "\n"}terminated by ${signal}` : stderr,
      });
    });
  });
}

interface ProjectEntry {
  path: string;
  commonDir: string;
  primary: boolean;
}

interface WorktreeRecord {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  prunable: boolean;
  primary?: boolean;
}

interface StatusRecord {
  path: string;
  staged: boolean;
  unstaged: boolean;
  conflict: boolean;
  untracked: boolean;
}

interface Numstat {
  paths: Set<string>;
  additions: number;
  deletions: number;
  binaryPaths: Set<string>;
}

interface WorkingSnapshot {
  path: string;
  status: StatusRecord[];
  numstat: Numstat;
  issue: string | null;
}

function normalize(path: string): string {
  return resolve(path);
}

function displayPath(path: string, home = homedir()): string {
  const normalized = normalize(path);
  const normalizedHome = normalize(home);
  if (normalized === normalizedHome) return "~";
  const fromHome = relative(normalizedHome, normalized);
  if (fromHome !== "" && !fromHome.startsWith("..") && !isAbsolute(fromHome)) {
    return `~/${fromHome}`;
  }
  return normalized;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return normalize(path);
  }
}

export function parseWorktrees(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | null = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      if (current) records.push(current);
      current = null;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) records.push(current);
      current = {
        path: field.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        prunable: false,
      };
    } else if (current && field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && field === "detached") {
      current.detached = true;
    } else if (current && (field === "prunable" || field.startsWith("prunable "))) {
      current.prunable = true;
    }
  }
  if (current) records.push(current);
  return records;
}

/** Parse porcelain v2 `-z`, including the extra source path after rename rows. */
export function parseStatus(output: string): StatusRecord[] {
  const chunks = output.split("\0");
  const records: StatusRecord[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk) continue;
    const kind = chunk[0];
    if (kind === "!") continue;
    if (kind === "?") {
      records.push({
        path: chunk.slice(2),
        staged: false,
        unstaged: false,
        conflict: false,
        untracked: true,
      });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const fields = chunk.split(" ");
    const xy = fields[1] ?? "..";
    const pathIndex = kind === "1" ? 8 : kind === "2" ? 9 : 10;
    records.push({
      path: fields.slice(pathIndex).join(" "),
      staged: kind !== "u" && xy[0] !== undefined && xy[0] !== ".",
      unstaged: kind !== "u" && xy[1] !== undefined && xy[1] !== ".",
      conflict: kind === "u",
      untracked: false,
    });
    if (kind === "2") index += 1;
  }
  return records;
}

export function parseNumstat(output: string): Numstat {
  const paths = new Set<string>();
  const binaryPaths = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const raw of output.split("\0")) {
    const record = raw.replace(/^\n+/, "");
    if (record === "") continue;
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    const path = record.slice(second + 1);
    if (path === "") continue;
    paths.add(path);
    if (added === "-" || deleted === "-") {
      binaryPaths.add(path);
      continue;
    }
    additions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(deleted, 10) || 0;
  }
  return { paths, additions, deletions, binaryPaths };
}

async function mapLimit<T, U>(
  values: readonly T[],
  limit: number,
  work: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await work(value, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

async function discoverProjects(root: string, git: GitRunner): Promise<ProjectEntry[]> {
  const dirents = await readdir(root, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) continue;
    const path = resolve(root, entry.name);
    let directory = entry.isDirectory();
    if (!directory && entry.isSymbolicLink()) {
      try {
        directory = (await stat(path)).isDirectory();
      } catch {
        directory = false;
      }
    }
    if (directory) candidates.push(path);
  }

  const inspected = await mapLimit(candidates, 8, async (candidate) => {
    const top = await git(candidate, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return null;
    const candidatePath = await canonical(candidate);
    const topPath = await canonical(top.stdout.trim());
    if (candidatePath !== topPath) return null;
    const [gitDirResult, common] = await Promise.all([
      git(candidate, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      git(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (
      gitDirResult.code !== 0 ||
      gitDirResult.stdout.trim() === "" ||
      common.code !== 0 ||
      common.stdout.trim() === ""
    )
      return null;
    const gitDir = await canonical(gitDirResult.stdout.trim());
    const commonDir = await canonical(common.stdout.trim());
    return {
      path: candidatePath,
      commonDir,
      primary: gitDir === commonDir,
    } satisfies ProjectEntry;
  });

  const byCommonDir = new Map<string, ProjectEntry>();
  for (const entry of inspected) {
    if (!entry) continue;
    const chosen = byCommonDir.get(entry.commonDir);
    if (!chosen || entry.primary || (!chosen.primary && entry.path < chosen.path)) {
      byCommonDir.set(entry.commonDir, entry);
    }
  }
  return [...byCommonDir.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function liveWorktrees(
  entry: ProjectEntry,
  git: GitRunner,
): Promise<{
  records: WorktreeRecord[];
  issue: string | null;
}> {
  const listed = await git(entry.path, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) {
    return { records: [], issue: listed.stderr.trim() || "could not list worktrees" };
  }
  const records: WorktreeRecord[] = [];
  let issue: string | null = null;
  for (const listedRecord of parseWorktrees(listed.stdout)) {
    // A primary checkout created with --separate-git-dir can be reported by
    // Git at the common directory itself. Discovery has already proven which
    // checkout owns that directory, so inspect the checkout rather than the
    // metadata directory in that one representation.
    const listedPath = await canonical(listedRecord.path);
    let record = listedRecord;
    if (listedPath === entry.commonDir) {
      if (entry.primary) {
        record = { ...listedRecord, path: entry.path };
      } else {
        const configured = await git(entry.path, ["config", "--path", "--get", "core.worktree"]);
        if (configured.code !== 0 || configured.stdout.trim() === "") {
          issue ??= "separate Git directory does not record the location of its primary checkout";
          continue;
        }
        const configuredPath = configured.stdout.trim();
        record = {
          ...listedRecord,
          path: await canonical(
            isAbsolute(configuredPath) ? configuredPath : resolve(entry.commonDir, configuredPath),
          ),
        };
      }
    }
    if (record.prunable) continue;
    try {
      if (!(await stat(record.path)).isDirectory()) continue;
    } catch {
      // Git can briefly retain a registration after its checkout disappears.
      continue;
    }
    const [gitDirResult, commonDirResult] = await Promise.all([
      git(record.path, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      git(record.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    ]);
    if (
      gitDirResult.code !== 0 ||
      commonDirResult.code !== 0 ||
      gitDirResult.stdout.trim() === "" ||
      commonDirResult.stdout.trim() === ""
    ) {
      issue ??=
        gitDirResult.stderr.trim() ||
        commonDirResult.stderr.trim() ||
        `could not identify worktree ${displayPath(record.path)}`;
      continue;
    }
    const [gitDir, commonDir] = await Promise.all([
      canonical(gitDirResult.stdout.trim()),
      canonical(commonDirResult.stdout.trim()),
    ]);
    records.push({ ...record, primary: gitDir === commonDir });
  }
  return { records, issue };
}

async function inspectWorking(path: string, git: GitRunner): Promise<WorkingSnapshot> {
  const [status, unstaged, staged] = await Promise.all([
    git(path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    git(path, ["diff", "--numstat", "-z", "--no-renames"]),
    git(path, ["diff", "--cached", "--numstat", "-z", "--no-renames"]),
  ]);
  const failures = [status, unstaged, staged].filter((result) => result.code !== 0);
  if (failures.length > 0) {
    return {
      path,
      status: status.code === 0 ? parseStatus(status.stdout) : [],
      numstat: parseNumstat(
        `${unstaged.code === 0 ? unstaged.stdout : ""}${staged.code === 0 ? staged.stdout : ""}`,
      ),
      issue: failures[0]?.stderr.trim() || "could not inspect working changes",
    };
  }
  const left = parseNumstat(unstaged.stdout);
  const right = parseNumstat(staged.stdout);
  return {
    path,
    status: parseStatus(status.stdout),
    numstat: {
      paths: new Set([...left.paths, ...right.paths]),
      additions: left.additions + right.additions,
      deletions: left.deletions + right.deletions,
      binaryPaths: new Set([...left.binaryPaths, ...right.binaryPaths]),
    },
    issue: null,
  };
}

function aggregateWorking(snapshots: readonly WorkingSnapshot[]): WorkingStats {
  const changed = new Set<string>();
  const binary = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const snapshot of snapshots) {
    for (const path of snapshot.numstat.paths) changed.add(`${snapshot.path}\0${path}`);
    for (const path of snapshot.numstat.binaryPaths) binary.add(`${snapshot.path}\0${path}`);
    additions += snapshot.numstat.additions;
    deletions += snapshot.numstat.deletions;
    for (const status of snapshot.status) {
      changed.add(`${snapshot.path}\0${status.path}`);
      if (status.staged) staged += 1;
      if (status.unstaged) unstaged += 1;
      if (status.untracked) untracked += 1;
      if (status.conflict) conflicts += 1;
    }
  }
  return {
    files: changed.size,
    additions,
    deletions,
    staged,
    unstaged,
    untracked,
    conflicts,
    binary: binary.size,
  };
}

async function inspectUnpushed(
  path: string,
  git: GitRunner,
): Promise<{
  stats: UnpushedStats;
  issue: string | null;
}> {
  const commits = await git(path, ["rev-list", "--branches", "--not", "--remotes"]);
  if (commits.code !== 0) {
    return {
      stats: { ...EMPTY_UNPUSHED },
      issue: commits.stderr.trim() || "could not inspect unpushed commits",
    };
  }
  const count = commits.stdout.split("\n").filter(Boolean).length;
  if (count === 0) return { stats: { ...EMPTY_UNPUSHED }, issue: null };
  const changes = await git(path, [
    "log",
    "--format=",
    "--numstat",
    "-z",
    "--no-renames",
    "--branches",
    "--not",
    "--remotes",
  ]);
  if (changes.code !== 0) {
    return {
      stats: { ...EMPTY_UNPUSHED, commits: count },
      issue: changes.stderr.trim() || "could not inspect unpushed file statistics",
    };
  }
  const parsed = parseNumstat(changes.stdout);
  return {
    stats: {
      commits: count,
      files: parsed.paths.size,
      additions: parsed.additions,
      deletions: parsed.deletions,
      binary: parsed.binaryPaths.size,
    },
    issue: null,
  };
}

async function resolvePrimary(
  path: string,
  git: GitRunner,
): Promise<{
  branch: string | null;
  ref: string | null;
  head: string | null;
  issue: string | null;
}> {
  const configured = await git(path, ["config", "--get", "supervisor.trunk"]);
  const branch =
    configured.code === 0 && configured.stdout.trim() !== "" ? configured.stdout.trim() : "main";
  const ref = `refs/heads/${branch}`;
  const exists = await git(path, ["show-ref", "--verify", "--quiet", ref]);
  if (exists.code !== 0) {
    return {
      branch: null,
      ref: null,
      head: null,
      issue: `primary branch ${branch} does not exist`,
    };
  }
  const head = await git(path, ["rev-parse", ref]);
  if (head.code !== 0 || head.stdout.trim() === "")
    return { branch, ref, head: null, issue: `primary branch ${branch} HEAD is unreadable` };
  return { branch, ref, head: head.stdout.trim(), issue: null };
}

async function inspectLinkedWorktree(
  record: WorktreeRecord,
  snapshot: WorkingSnapshot | undefined,
  primary: { branch: string | null; ref: string | null },
  git: GitRunner,
): Promise<WorktreeStatus> {
  const head = record.head ?? "";
  const issue = snapshot?.issue ?? (head === "" ? "worktree HEAD is unreadable" : null);
  if (!primary.ref || head === "") {
    return {
      path: record.path,
      displayPath: displayPath(record.path),
      branch: record.detached ? null : record.branch,
      head,
      working: aggregateWorking(snapshot ? [snapshot] : []),
      ahead: null,
      behind: null,
      mergeState: "unknown",
      issue,
      agents: [],
      panes: [],
      ci: null,
    };
  }
  const [counts, contained] = await Promise.all([
    git(record.path, ["rev-list", "--left-right", "--count", `${primary.ref}...${head}`]),
    git(record.path, ["merge-base", "--is-ancestor", head, primary.ref]),
  ]);
  const [behindText, aheadText] = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  const countIssue = counts.code !== 0 || !Number.isFinite(ahead) || !Number.isFinite(behind);
  const mergeIssue = contained.code !== 0 && contained.code !== 1;
  return {
    path: record.path,
    displayPath: displayPath(record.path),
    branch: record.detached ? null : record.branch,
    head,
    working: aggregateWorking(snapshot ? [snapshot] : []),
    ahead: countIssue || mergeIssue ? null : ahead,
    behind: countIssue || mergeIssue ? null : behind,
    mergeState: countIssue || mergeIssue ? "unknown" : contained.code === 0 ? "merged" : "unmerged",
    issue:
      issue ??
      (countIssue || mergeIssue
        ? counts.stderr.trim() || contained.stderr.trim() || "could not compare with primary branch"
        : null),
    agents: [],
    panes: [],
    ci: null,
  };
}

async function inspectProject(
  entry: ProjectEntry,
  git: GitRunner,
): Promise<{ project: ProjectStatus; diagnostics: string[] }> {
  const diagnostics: string[] = [];
  const listed = await liveWorktrees(entry, git);
  if (listed.issue) diagnostics.push(`${displayPath(entry.path)}: ${listed.issue}`);
  const snapshots = await mapLimit(listed.records, 4, async (record) =>
    inspectWorking(record.path, git),
  );
  for (const snapshot of snapshots) {
    if (snapshot.issue) diagnostics.push(`${displayPath(snapshot.path)}: ${snapshot.issue}`);
  }
  const [unpushed, primary] = await Promise.all([
    inspectUnpushed(entry.path, git),
    resolvePrimary(entry.path, git),
  ]);
  const issues: string[] = [];
  if (listed.issue) issues.push(listed.issue);
  if (unpushed.issue) issues.push(unpushed.issue);
  if (primary.issue) issues.push(primary.issue);

  const linked = listed.records.filter((record) => record.primary !== true);
  const worktrees = await mapLimit(linked, 4, async (record) => {
    const snapshot = snapshots.find(
      (candidate) => normalize(candidate.path) === normalize(record.path),
    );
    return inspectLinkedWorktree(record, snapshot, primary, git);
  });
  const primaryRecord = listed.records.find((record) => record.primary === true);
  const primarySnapshot = primaryRecord
    ? snapshots.find((candidate) => normalize(candidate.path) === normalize(primaryRecord.path))
    : undefined;
  return {
    project: {
      name: basename(entry.path),
      path: entry.path,
      displayPath: displayPath(entry.path),
      primaryBranch: primary.branch,
      primaryHead: primary.head,
      primaryWorking: aggregateWorking(primarySnapshot ? [primarySnapshot] : []),
      unpushed: unpushed.stats,
      agents: [],
      panes: [],
      worktrees: worktrees.sort((left, right) => left.displayPath.localeCompare(right.displayPath)),
      issues,
      githubVisibility: null,
      primaryCi: null,
    },
    diagnostics,
  };
}

export interface ScanOptions {
  root?: string;
  git?: GitRunner;
  herdr?: HerdrRunner;
  includeQuiet?: boolean;
}

export function projectIsVisible(project: ProjectStatus): boolean {
  const ciNeedsAttention =
    project.primaryCi?.state === "PENDING" ||
    project.primaryCi?.state === "FAIL" ||
    project.worktrees.some(
      (worktree) => worktree.ci?.state === "PENDING" || worktree.ci?.state === "FAIL",
    );
  return (
    project.primaryWorking.files > 0 ||
    project.worktrees.some((worktree) => worktree.working.files > 0) ||
    project.unpushed.commits > 0 ||
    project.worktrees.length > 0 ||
    project.agents.length > 0 ||
    ciNeedsAttention
  );
}

/** Scan direct projects under ~/code. The operation is entirely read-only. */
export async function scanProjects(options: ScanOptions = {}): Promise<ScanResult> {
  const root = normalize(options.root ?? resolve(homedir(), "code"));
  const git = options.git ?? runGit;
  const herdrSnapshot = readHerdrSnapshot(options.herdr ?? runHerdr);
  let entries: ProjectEntry[];
  try {
    entries = await discoverProjects(root, git);
  } catch (error) {
    const presence = await herdrSnapshot;
    return {
      root,
      projects: [],
      agentPresence: {
        available: presence.available,
        diagnostics: presence.diagnostics,
      },
      ci: { available: false, projections: [], diagnostics: ["CI projection not requested"] },
      diagnostics: [error instanceof Error ? error.message : String(error)],
      scannedAt: new Date(),
    };
  }
  const [inspected, presence] = await Promise.all([
    mapLimit(entries, 4, async (entry) => inspectProject(entry, git)),
    herdrSnapshot,
  ]);
  const projects = inspected.map(({ project }) => project);
  await attachAgentPresence(projects, presence);
  return {
    root,
    projects: projects
      .filter((project) => options.includeQuiet === true || projectIsVisible(project))
      .sort((left, right) => left.name.localeCompare(right.name)),
    agentPresence: {
      available: presence.available,
      diagnostics: presence.diagnostics,
    },
    ci: { available: false, projections: [], diagnostics: ["CI projection not requested"] },
    diagnostics: inspected.flatMap(({ diagnostics }) => diagnostics),
    scannedAt: new Date(),
  };
}

export const EMPTY_STATS = {
  working: EMPTY_WORKING,
  unpushed: EMPTY_UNPUSHED,
} as const;
