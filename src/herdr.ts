import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentPresence, ProjectStatus } from "./types.ts";

export interface HerdrResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HerdrRunner = (args: readonly string[]) => Promise<HerdrResult>;

interface HerdrAgent extends AgentPresence {
  cwd: string | null;
}

interface HerdrWorkspace {
  workspaceId: string;
  checkoutPath: string | null;
}

export interface HerdrSnapshot {
  available: boolean;
  agents: HerdrAgent[];
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
  return parseEnvelope(output, "agent", "agents").map((value, index) => {
    const item = record(value);
    if (!item) throw new Error(`herdr agent list has an invalid agent at index ${index}`);
    const session = record(item.agent_session);
    const tokens = record(item.tokens);
    if (typeof item.focused !== "boolean") {
      throw new Error(`herdr agent list agent ${index} omitted focused`);
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
  const [agentsResult, workspacesResult] = await Promise.all([
    runner(["agent", "list"]),
    runner(["workspace", "list"]),
  ]);
  if (agentsResult.code !== 0) {
    return {
      available: false,
      agents: [],
      workspaces: [],
      diagnostics: [failedCommand("agent", agentsResult)],
    };
  }
  let agents: HerdrAgent[];
  try {
    agents = parseHerdrAgents(agentsResult.stdout);
  } catch (error) {
    return {
      available: false,
      agents: [],
      workspaces: [],
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
  if (workspacesResult.code !== 0) {
    return {
      available: true,
      agents,
      workspaces: [],
      diagnostics: [failedCommand("workspace", workspacesResult)],
    };
  }
  try {
    return {
      available: true,
      agents,
      workspaces: parseHerdrWorkspaces(workspacesResult.stdout),
      diagnostics: [],
    };
  } catch (error) {
    return {
      available: true,
      agents,
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

/** Attach each Herdr agent to exactly one known, most-specific checkout. */
export async function attachAgentPresence(
  projects: readonly ProjectStatus[],
  snapshot: HerdrSnapshot,
): Promise<void> {
  const targets = projects.flatMap((project) => [
    { path: project.path, agents: project.agents },
    ...project.worktrees.map((worktree) => ({ path: worktree.path, agents: worktree.agents })),
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
  for (const target of targets) target.agents.sort(compareAgents);
}
