import { describe, expect, test } from "bun:test";
import { applyCiObservation, normalizeCiState } from "../src/ci-observation.ts";
import type { CiProjection, ProjectStatus, ScanResult } from "../src/types.ts";

const project = (worktree = false): ProjectStatus => ({
  name: "project",
  path: "/code/project",
  displayPath: "~/code/project",
  primaryBranch: "main",
  primaryHead: "primary-sha",
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
  worktrees: worktree
    ? [
        {
          path: "/worktrees/project/topic",
          displayPath: "~/worktrees/project/topic",
          branch: "topic",
          head: "local-sha",
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
          ahead: 1,
          behind: 0,
          mergeState: "unmerged",
          issue: null,
          agents: [],
          panes: [],
          ci: null,
        },
      ]
    : [],
  issues: [],
  primaryCi: null,
});

function scan(projects: ProjectStatus[]): ScanResult {
  return {
    root: "/code",
    projects,
    agentPresence: { available: true, diagnostics: [] },
    ci: { available: false, projections: [], diagnostics: [] },
    diagnostics: [],
    scannedAt: new Date("2026-08-28T00:00:00Z"),
  };
}

function projection(primary: "SUCCESS" | "FAILURE", local = false): CiProjection {
  return {
    schemaVersion: 2,
    revision: 1,
    projectedAt: "2026-08-28T00:00:00Z",
    owner: "possibilities",
    repo: "project",
    paths: ["/code/project"],
    available: true,
    defaultBranch: "main",
    primaryBranch: "main",
    heads: [
      {
        sha: "primary-sha",
        committedAt: null,
        aggregateState: primary,
        contexts: [],
        diagnostics: [],
      },
      ...(local
        ? [
            {
              sha: "local-sha",
              committedAt: null,
              aggregateState: "LOCAL" as const,
              contexts: [],
              diagnostics: [],
            },
          ]
        : []),
    ],
    targets: [],
    diagnostics: [],
  };
}

describe("CI observations", () => {
  test("normalizes GitHub aggregate states", () => {
    expect(normalizeCiState("SUCCESS")).toBe("PASS");
    expect(normalizeCiState("EXPECTED")).toBe("PENDING");
    expect(normalizeCiState("ERROR")).toBe("FAIL");
    expect(normalizeCiState("LOCAL")).toBe("LOCAL");
    expect(normalizeCiState("UNAVAILABLE")).toBe("UNKNOWN");
  });

  test("CI failure retains an otherwise quiet project while success does not", () => {
    const failed = applyCiObservation(scan([project()]), {
      available: true,
      projections: [projection("FAILURE")],
      diagnostics: [],
    });
    expect(failed.projects[0]?.primaryCi?.state).toBe("FAIL");
    const passed = applyCiObservation(scan([project()]), {
      available: true,
      projections: [projection("SUCCESS")],
      diagnostics: [],
    });
    expect(passed.projects).toEqual([]);
  });

  test("joins each checkout by exact SHA and exposes full projections", () => {
    const value = projection("SUCCESS", true);
    const observed = applyCiObservation(scan([project(true)]), {
      available: true,
      projections: [value],
      diagnostics: [],
    });
    expect(observed.projects[0]).toMatchObject({
      primaryCi: { state: "PASS", headSha: "primary-sha" },
      worktrees: [{ ci: { state: "LOCAL", headSha: "local-sha" } }],
    });
    expect(observed.ci.projections).toEqual([value]);
  });

  test("an unavailable socket never presents retained projections as current", () => {
    const retained = project();
    retained.agents.push({
      agent: "codex",
      status: "idle",
      conversation: null,
      sessionId: null,
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      focused: false,
    });
    const observed = applyCiObservation(scan([retained]), {
      available: false,
      projections: [projection("FAILURE")],
      diagnostics: ["connection closed"],
    });
    expect(observed.projects[0]?.primaryCi?.state).toBe("UNKNOWN");
    expect(observed.ci.projections).toEqual([]);
  });
});
