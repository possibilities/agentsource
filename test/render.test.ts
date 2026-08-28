import { describe, expect, test } from "bun:test";
import { stringWidth } from "bun";
import {
  plainText,
  renderFailurePanel,
  renderJson,
  renderProject,
  renderScan,
  renderSnapshot,
} from "../src/render.ts";
import type { ProjectStatus, ScanResult } from "../src/types.ts";

const PROJECT: ProjectStatus = {
  name: "an-extremely-long-project-name-that-must-compress",
  path: "/Users/example/code/project",
  displayPath: "~/code/project",
  primaryBranch: "main",
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
  working: {
    files: 4,
    additions: 120,
    deletions: 9,
    staged: 1,
    unstaged: 2,
    untracked: 1,
    conflicts: 0,
    binary: 0,
  },
  unpushed: { commits: 3, files: 7, additions: 44, deletions: 2, binary: 1 },
  agents: [
    {
      agent: "codex",
      status: "working",
      conversation: "agent-presence-in-signal-room",
      sessionId: "session-primary",
      paneId: "w1:p1",
      tabId: "w1:t1",
      workspaceId: "w1",
      focused: true,
    },
  ],
  worktrees: [
    {
      path: "/Users/example/.herdr/worktrees/project/worktree-long-name",
      displayPath: "~/.herdr/worktrees/project/worktree-long-name",
      branch: "worktree/long-running-feature-branch",
      head: "1234567890abcdef",
      working: {
        files: 4,
        additions: 120,
        deletions: 9,
        staged: 1,
        unstaged: 2,
        untracked: 1,
        conflicts: 0,
        binary: 0,
      },
      ahead: 3,
      behind: 1,
      mergeState: "unmerged",
      issue: null,
      agents: [
        {
          agent: "claude",
          status: "idle",
          conversation: "review-agent-presence",
          sessionId: "session-linked",
          paneId: "w2:p1",
          tabId: "w2:t1",
          workspaceId: "w2",
          focused: false,
        },
      ],
    },
  ],
  issues: [],
};

const RESULT: ScanResult = {
  root: "/Users/example/code",
  projects: [PROJECT],
  agentPresence: { available: true, diagnostics: [] },
  diagnostics: [],
  scannedAt: new Date("2026-08-26T00:00:00Z"),
};

describe("responsive renderer", () => {
  for (const width of [40, 80, 120]) {
    test(`clips every dynamic row at ${width} columns`, () => {
      const lines = renderProject(PROJECT, width);
      expect(lines.length).toBeGreaterThan(4);
      for (const line of lines) {
        expect(stringWidth(line.map((part) => part.text).join(""))).toBeLessThanOrEqual(width);
      }
      expect(lines[0]?.map((part) => part.text).join("")).toContain(width < 66 ? "1w" : "1 linked");
    });
  }

  test("live frames are chromeless while snapshots carry provenance", () => {
    const frame = plainText(renderScan(RESULT, 100));
    expect(frame).toContain(
      "▎ 1 PROJECT · 1 LINKED WORKTREE · 4 WORKING FILES · 3 UNPUSHED COMMITS",
    );
    expect(frame).toContain("WORKING");
    expect(frame).toContain("UNPUSHED");
    expect(frame).toContain("WORKING    clean");
    expect(frame).toContain("4 files · +120 -9");
    expect(frame).toContain("DIVERGED FROM main · 3 ahead · 1 behind");
    expect(frame).toContain("codex WORKING");
    expect(frame).toContain("claude IDLE");
    expect(frame).not.toContain("AGENTSOURCE");
    expect(frame).not.toContain("commands");
    expect(renderSnapshot(RESULT, 100)).toStartWith("AGENTSOURCE · /Users/example/code");
  });

  test("totals aggregate the observation and compress into a narrow two-row readout", () => {
    const aggregate = {
      ...RESULT,
      projects: [
        PROJECT,
        {
          ...PROJECT,
          name: "another-project",
          working: { ...PROJECT.working, files: 2 },
          unpushed: { ...PROJECT.unpushed, commits: 5 },
          worktrees: [...PROJECT.worktrees, ...PROJECT.worktrees],
        },
      ],
    };
    const wide = plainText(renderScan(aggregate, 120)).split("\n")[0];
    expect(wide).toBe(
      "▎ 2 PROJECTS · 3 LINKED WORKTREES · 6 WORKING FILES · 8 UNPUSHED COMMITS · 5 HERDR AGENTS",
    );

    const narrow = plainText(renderScan(RESULT, 40)).split("\n").slice(0, 2);
    expect(narrow).toEqual(["▎ PROJECTS  1   WORKTREES 1", "  WORKING   4   UNPUSHED  3"]);
    for (const line of narrow) expect(stringWidth(line)).toBeLessThanOrEqual(40);
  });

  test("empty state names the refresh command without adding a help rail", () => {
    const empty = plainText(renderScan({ ...RESULT, projects: [] }, 80));
    expect(empty).toStartWith(
      "▎ 0 PROJECTS · 0 LINKED WORKTREES · 0 WORKING FILES · 0 UNPUSHED COMMITS",
    );
    expect(empty).toContain("○ CLEAR");
    expect(empty).toContain("Run refresh from the command palette");
    expect(empty).not.toContain("ctrl+k");
  });

  test("linked worktree relationship leads with behind and diverged states", () => {
    const template = PROJECT.worktrees[0];
    if (!template) throw new Error("test fixture has no worktree");
    const behind = {
      ...PROJECT,
      worktrees: [{ ...template, ahead: 0, behind: 11, mergeState: "merged" as const }],
    };
    expect(plainText(renderProject(behind, 100))).toContain("BEHIND main · 11 commits");
    expect(plainText(renderProject(behind, 40))).toContain("BEHIND main -11");

    const diverged = {
      ...PROJECT,
      worktrees: [{ ...template, ahead: 3, behind: 11, mergeState: "unmerged" as const }],
    };
    expect(plainText(renderProject(diverged, 100))).toContain(
      "DIVERGED FROM main · 3 ahead · 11 behind",
    );
  });

  test("sanitizes controls and clips Unicode by terminal cells without splitting graphemes", () => {
    const templateWorktree = PROJECT.worktrees[0];
    if (!templateWorktree) throw new Error("test fixture has no worktree");
    const unusual: ProjectStatus = {
      ...PROJECT,
      name: "界面👨‍👩‍👧‍👦\u001b[31m\nrepo",
      displayPath: "~/code/界面\u0007repo",
      primaryBranch: "ma\u202ein",
      worktrees: [
        {
          ...templateWorktree,
          branch: "feature/界面👨‍👩‍👧‍👦\u001b[2J",
          displayPath: "~/tree\nunsafe",
          issue: "bad\u0000message",
        },
      ],
      issues: ["warning\u001b[Hcontrol"],
    };
    const lines = renderProject(unusual, 40);
    for (const line of lines) {
      const text = line.map((part) => part.text).join("");
      expect(stringWidth(text)).toBeLessThanOrEqual(40);
      expect(
        [...text].some((character) => {
          const point = character.codePointAt(0) ?? 0;
          return (
            point <= 0x1f ||
            point === 0x061c ||
            (point >= 0x7f && point <= 0x9f) ||
            point === 0x200e ||
            point === 0x200f ||
            (point >= 0x202a && point <= 0x202e) ||
            (point >= 0x2066 && point <= 0x206f)
          );
        }),
      ).toBe(false);
      for (const part of line) expect(part.text.endsWith("‍")).toBe(false);
    }
  });

  test("failure state reserves its retry affordance for the fixed panel", () => {
    const failed = { ...RESULT, projects: [], diagnostics: ["cannot read root"] };
    expect(plainText(renderScan(failed, 40))).not.toContain("FAILED");
    expect(plainText([renderFailurePanel(40)])).toBe("FAILED · R REFRESH");
  });

  test("snapshot provenance is sanitized and clipped", () => {
    const snapshot = renderSnapshot({ ...RESULT, root: "/tmp/界面\n\u001b[2Jroot" }, 18);
    const title = snapshot.split("\n")[0] ?? "";
    expect(stringWidth(title)).toBeLessThanOrEqual(18);
    expect(title).not.toContain("\u001b");
    expect(title).not.toContain("\n");
  });

  test("JSON observations expose the complete versioned scan", () => {
    const output = renderJson(RESULT);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 2,
      scannedAt: "2026-08-26T00:00:00.000Z",
      root: RESULT.root,
      projects: RESULT.projects,
      agentPresence: RESULT.agentPresence,
      diagnostics: RESULT.diagnostics,
    });
  });
});
