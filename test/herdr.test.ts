import { describe, expect, test } from "bun:test";
import {
  attachAgentPresence,
  type HerdrRunner,
  type HerdrSnapshot,
  parseHerdrAgents,
  parseHerdrApiSnapshot,
  parseHerdrWorkspaces,
  readHerdrSnapshot,
} from "../src/herdr.ts";
import type { ProjectStatus } from "../src/types.ts";

function envelope(kind: "agent" | "workspace", values: unknown[]): string {
  const key = kind === "agent" ? "agents" : "workspaces";
  return JSON.stringify({
    id: `cli:${kind}:list`,
    result: { type: `${kind}_list`, [key]: values },
  });
}

function apiSnapshot(panes: unknown[]): string {
  return JSON.stringify({
    id: "cli:api:snapshot",
    result: { type: "snapshot", snapshot: { panes } },
  });
}

function project(): ProjectStatus {
  return {
    name: "project",
    path: "/tmp/code/project",
    displayPath: "/tmp/code/project",
    primaryBranch: "main",
    primaryHead: "primary",
    primaryCi: null,
    primaryWorking: {
      files: 0,
      additions: 0,
      deletions: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      binary: 0,
    },
    unpushed: { commits: 0, files: 0, additions: 0, deletions: 0, binary: 0 },
    agents: [],
    panes: [],
    worktrees: [
      {
        path: "/tmp/code/project/nested-worktree",
        displayPath: "/tmp/code/project/nested-worktree",
        branch: "feature",
        head: "abc",
        working: {
          files: 0,
          additions: 0,
          deletions: 0,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicts: 0,
          binary: 0,
        },
        ahead: 0,
        behind: 0,
        mergeState: "unmerged",
        issue: null,
        agents: [],
        panes: [],
        ci: null,
      },
    ],
    issues: [],
    githubVisibility: null,
  };
}

describe("Herdr snapshots", () => {
  test("normalizes the useful agent and workspace fields", () => {
    expect(
      parseHerdrAgents(
        envelope("agent", [
          {
            agent: "codex",
            agent_status: "working",
            cwd: "/tmp/project",
            focused: true,
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            agent_session: { value: "session-1" },
            tokens: { conversation: "agent-presence" },
          },
        ]),
      ),
    ).toEqual([
      {
        agent: "codex",
        status: "working",
        cwd: "/tmp/project",
        conversation: "agent-presence",
        sessionId: "session-1",
        paneId: "w1:p1",
        tabId: "w1:t1",
        workspaceId: "w1",
        focused: true,
      },
    ]);
    expect(
      parseHerdrApiSnapshot(
        apiSnapshot([
          {
            agent: null,
            agent_status: "unknown",
            cwd: "/tmp/project",
            foreground_cwd: "/tmp/project/src",
            focused: false,
            pane_id: "w2:p1",
            tab_id: "w2:t1",
            workspace_id: "w2",
            terminal_title_stripped: "shell",
          },
        ]),
      ).panes,
    ).toEqual([
      {
        cwd: "/tmp/project/src",
        paneId: "w2:p1",
        tabId: "w2:t1",
        workspaceId: "w2",
        title: "shell",
        focused: false,
      },
    ]);
    expect(
      parseHerdrWorkspaces(
        envelope("workspace", [
          { workspace_id: "w1", worktree: { checkout_path: "/tmp/project" } },
          { workspace_id: "w2" },
        ]),
      ),
    ).toEqual([
      { workspaceId: "w1", checkoutPath: "/tmp/project" },
      { workspaceId: "w2", checkoutPath: null },
    ]);
  });

  test("takes each list snapshot once and retains cwd association if workspace metadata fails", async () => {
    const calls: string[] = [];
    const runner: HerdrRunner = async (args) => {
      calls.push(args.join(" "));
      if (args[0] === "api") {
        return {
          code: 0,
          stdout: apiSnapshot([
            {
              agent: "codex",
              agent_status: "idle",
              cwd: "/tmp/project",
              focused: false,
              pane_id: "w1:p1",
              tab_id: "w1:t1",
              workspace_id: "w1",
            },
            {
              agent: null,
              cwd: "/tmp/project",
              focused: false,
              pane_id: "w1:p2",
              tab_id: "w1:t1",
              workspace_id: "w1",
            },
          ]),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "surface unavailable" };
    };
    const snapshot = await readHerdrSnapshot(runner);
    expect(calls.sort()).toEqual(["api snapshot", "workspace list"]);
    expect(snapshot.available).toBe(true);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.panes).toHaveLength(1);
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.diagnostics).toEqual(["herdr workspace list exited 1: surface unavailable"]);
  });

  test("workspace checkout metadata wins, then cwd uses the most-specific checkout", async () => {
    const observed = project();
    const base = {
      agent: "codex",
      status: "idle",
      conversation: null,
      sessionId: null,
      tabId: "w:t",
      focused: false,
    };
    const snapshot: HerdrSnapshot = {
      available: true,
      agents: [
        {
          ...base,
          cwd: null,
          paneId: "workspace-wins",
          workspaceId: "linked",
        },
        {
          ...base,
          cwd: `${observed.worktrees[0]?.path}/src`,
          paneId: "cwd-fallback",
          workspaceId: "without-metadata",
        },
        {
          ...base,
          cwd: "/tmp/code/project-neighbor",
          paneId: "unrelated",
          workspaceId: "unrelated",
        },
      ],
      panes: [
        {
          cwd: null,
          paneId: "open-pane",
          tabId: "w:t",
          workspaceId: "linked",
          title: null,
          focused: false,
        },
      ],
      workspaces: [{ workspaceId: "linked", checkoutPath: observed.worktrees[0]?.path ?? null }],
      diagnostics: [],
    };
    await attachAgentPresence([observed], snapshot);
    expect(observed.agents).toEqual([]);
    expect(observed.worktrees[0]?.agents.map((agent) => agent.paneId)).toEqual([
      "cwd-fallback",
      "workspace-wins",
    ]);
    expect(observed.worktrees[0]?.panes.map((pane) => pane.paneId)).toEqual(["open-pane"]);
  });

  test("malformed pane output is unavailable rather than partial", async () => {
    const snapshot = await readHerdrSnapshot(async (args) => ({
      code: 0,
      stdout: args[0] === "api" ? "{}" : envelope("workspace", []),
      stderr: "",
    }));
    expect(snapshot).toMatchObject({ available: false, agents: [], panes: [], workspaces: [] });
    expect(snapshot.diagnostics[0]).toContain("omitted panes");
  });
});
