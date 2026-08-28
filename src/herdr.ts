import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentPresence, HerdrPanePresence, ProjectStatus } from "./types.ts";

export interface HerdrResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HerdrRunner = (args: readonly string[]) => Promise<HerdrResult>;

interface HerdrAgent extends AgentPresence {
  cwd: string | null;
}

interface HerdrPane extends HerdrPanePresence {
  cwd: string | null;
}

interface HerdrWorkspace {
  workspaceId: string;
  checkoutPath: string | null;
}

export interface HerdrSnapshot {
  available: boolean;
  agents: HerdrAgent[];
  panes: HerdrPane[];
  workspaces: HerdrWorkspace[];
  diagnostics: string[];
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`missing ${field}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseEnvelope(output: string, kind: string, key: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`herdr ${kind} list returned invalid JSON`);
  }
  const envelope = record(parsed);
  const result = record(envelope?.result);
  const values = result?.[key];
  if (!Array.isArray(values)) throw new Error(`herdr ${kind} list omitted ${key}`);
  return values;
}

export function parseHerdrAgents(output: string): HerdrAgent[] {
  return parseAgentValues(parseEnvelope(output, "agent", "agents"));
}

function parseAgentValues(values: unknown[]): HerdrAgent[] {
  return values.map((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`herdr snapshot has an invalid agent at index ${index}`);
    const session = record(item.agent_session);
    const tokens = record(item.tokens);
    if (typeof item.focused !== "boolean") {
      throw new Error(`herdr snapshot agent ${index} omitted focused`);
    }
    return {
      agent: optionalString(item.agent) ?? optionalString(item.display_agent) ?? "unknown",
      status: requiredString(item.agent_status, `agent ${index} status`),
      cwd: optionalString(item.cwd),
      conversation: optionalString(tokens?.conversation),
      sessionId: optionalString(session?.value),
      paneId: requiredString(item.pane_id, `agent ${index} pane_id`),
      tabId: requiredString(item.tab_id, `agent ${index} tab_id`),
      workspaceId: requiredString(item.workspace_id, `agent ${index} workspace_id`),
      focused: item.focused,
    };
  });
}

export function parseHerdrApiSnapshot(output: string): {
  agents: HerdrAgent[];
  panes: HerdrPane[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("herdr api snapshot returned invalid JSON");
  }
  const snapshot = record(record(record(parsed)?.result)?.snapshot);
  if (!snapshot || !Array.isArray(snapshot.panes))
    throw new Error("herdr api snapshot omitted panes");
  const hasAgent = (value: unknown): boolean => {
    const item = record(value);
    return Boolean(optionalString(item?.agent) ?? optionalString(item?.display_agent));
  };
  const agentValues = snapshot.panes.filter(hasAgent);
  const panes = snapshot.panes.flatMap((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`herdr api snapshot has an invalid pane at index ${index}`);
    if (hasAgent(item)) return [];
    if (typeof item.focused !== "boolean")
      throw new Error(`herdr api snapshot pane ${index} omitted focused`);
    return [
      {
        cwd: optionalString(item.foreground_cwd) ?? optionalString(item.cwd),
        paneId: requiredString(item.pane_id, `pane ${index} pane_id`),
        tabId: requiredString(item.tab_id, `pane ${index} tab_id`),
        workspaceId: requiredString(item.workspace_id, `pane ${index} workspace_id`),
        title: optionalString(item.terminal_title_stripped),
        focused: item.focused,
      },
    ];
  });
  return { agents: parseAgentValues(agentValues), panes };
}

export function parseHerdrWorkspaces(output: string): HerdrWorkspace[] {
  return parseEnvelope(output, "workspace", "workspaces").map((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`herdr workspace list has an invalid workspace at index ${index}`);
    const worktree = record(item.worktree);
    return {
      workspaceId: requiredString(item.workspace_id, `workspace ${index} workspace_id`),
      checkoutPath: optionalString(worktree?.checkout_path),
    };
  });
}

/** Run Herdr without a shell. Both list commands are read-only snapshots. */
export async function runHerdr(args: readonly string[]): Promise<HerdrResult> {
  return await new Promise((resolveResult) => {
    const child = spawn("herdr", args, { stdio: ["ignore", "pipe", "pipe"] });
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
    const timer = setTimeout(() => child.kill("SIGTERM"), 2_000);
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

function failedCommand(kind: string, result: HerdrResult): string {
  const detail = result.stderr.trim();
  return `herdr ${kind} list exited ${result.code}${detail === "" ? "" : `: ${detail}`}`;
}

/** Take one bounded Herdr snapshot, degrading workspace metadata to cwd matching. */
export async function readHerdrSnapshot(runner: HerdrRunner = runHerdr): Promise<HerdrSnapshot> {
  const [snapshotResult, workspacesResult] = await Promise.all([
    runner(["api", "snapshot"]),
    runner(["workspace", "list"]),
  ]);
  if (snapshotResult.code !== 0) {
    return {
      available: false,
      agents: [],
      panes: [],
      workspaces: [],
      diagnostics: [failedCommand("api snapshot", snapshotResult)],
    };
  }
  let snapshot: { agents: HerdrAgent[]; panes: HerdrPane[] };
  try {
    snapshot = parseHerdrApiSnapshot(snapshotResult.stdout);
  } catch (error) {
    return {
      available: false,
      agents: [],
      panes: [],
      workspaces: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (workspacesResult.code !== 0) {
    return {
      available: true,
      agents: snapshot.agents,
      panes: snapshot.panes,
      workspaces: [],
      diagnostics: [failedCommand("workspace", workspacesResult)],
    };
  }
  try {
    return {
      available: true,
      agents: snapshot.agents,
      panes: snapshot.panes,
      workspaces: parseHerdrWorkspaces(workspacesResult.stdout),
      diagnostics: [],
    };
  } catch (error) {
    return {
      available: true,
      agents: snapshot.agents,
      panes: snapshot.panes,
      workspaces: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function contains(checkout: string, candidate: string): boolean {
  const child = relative(checkout, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function compareAgents(left: AgentPresence, right: AgentPresence): number {
  if (left.focused !== right.focused) return left.focused ? -1 : 1;
  return (
    left.agent.localeCompare(right.agent) ||
    (left.conversation ?? "").localeCompare(right.conversation ?? "") ||
    left.paneId.localeCompare(right.paneId)
  );
}

function comparePanes(left: HerdrPanePresence, right: HerdrPanePresence): number {
  if (left.focused !== right.focused) return left.focused ? -1 : 1;
  return (
    (left.title ?? "").localeCompare(right.title ?? "") || left.paneId.localeCompare(right.paneId)
  );
}

/** Attach each Herdr agent to exactly one known, most-specific checkout. */
export async function attachAgentPresence(
  projects: readonly ProjectStatus[],
  snapshot: HerdrSnapshot,
): Promise<void> {
  const targets = projects.flatMap((project) => [
    { path: project.path, agents: project.agents, panes: project.panes },
    ...project.worktrees.map((worktree) => ({
      path: worktree.path,
      agents: worktree.agents,
      panes: worktree.panes,
    })),
  ]);
  const canonicalTargets = await Promise.all(
    targets.map(async (target) => ({ ...target, canonicalPath: await canonical(target.path) })),
  );
  canonicalTargets.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length);
  const workspacePaths = new Map(
    await Promise.all(
      snapshot.workspaces.flatMap((workspace) =>
        workspace.checkoutPath
          ? [
              canonical(workspace.checkoutPath).then(
                (path) => [workspace.workspaceId, path] as const,
              ),
            ]
          : [],
      ),
    ),
  );
  for (const agent of snapshot.agents) {
    const workspacePath = workspacePaths.get(agent.workspaceId);
    const cwd = agent.cwd ? await canonical(agent.cwd) : undefined;
    const target =
      canonicalTargets.find(
        (candidate) =>
          (workspacePath !== undefined && contains(candidate.canonicalPath, workspacePath)) ||
          (workspacePath === undefined &&
            cwd !== undefined &&
            contains(candidate.canonicalPath, cwd)),
      ) ??
      (workspacePath !== undefined && cwd !== undefined
        ? canonicalTargets.find((candidate) => contains(candidate.canonicalPath, cwd))
        : undefined);
    if (!target) continue;
    const { cwd: _cwd, ...presence } = agent;
    target.agents.push(presence);
  }
  for (const pane of snapshot.panes) {
    const workspacePath = workspacePaths.get(pane.workspaceId);
    const cwd = pane.cwd ? await canonical(pane.cwd) : undefined;
    const target =
      canonicalTargets.find(
        (candidate) =>
          (workspacePath !== undefined && contains(candidate.canonicalPath, workspacePath)) ||
          (workspacePath === undefined &&
            cwd !== undefined &&
            contains(candidate.canonicalPath, cwd)),
      ) ??
      (workspacePath !== undefined && cwd !== undefined
        ? canonicalTargets.find((candidate) => contains(candidate.canonicalPath, cwd))
        : undefined);
    if (!target) continue;
    const { cwd: _cwd, ...presence } = pane;
    target.panes.push(presence);
  }
  for (const target of targets) {
    target.agents.sort(compareAgents);
    target.panes.sort(comparePanes);
  }
}
