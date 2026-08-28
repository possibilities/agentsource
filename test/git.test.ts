import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNumstat, parseStatus, parseWorktrees, scanProjects } from "../src/git.ts";
import type { HerdrRunner } from "../src/herdr.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Agentsource Test",
  GIT_AUTHOR_EMAIL: "agentsource@example.invalid",
  GIT_COMMITTER_NAME: "Agentsource Test",
  GIT_COMMITTER_EMAIL: "agentsource@example.invalid",
};

const EMPTY_HERDR: HerdrRunner = async (args) => ({
  code: 0,
  stdout: JSON.stringify({
    id: `cli:${args[0]}:list`,
    result:
      args[0] === "agent"
        ? { type: "agent_list", agents: [] }
        : { type: "workspace_list", workspaces: [] },
  }),
  stderr: "",
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createPushedProject(root: string, name: string): string {
  const project = join(root, name);
  const remote = join(root, `${name}.git`);
  mkdirSync(project);
  git(project, "init", "-b", "main");
  git(root, "init", "--bare", remote);
  writeFileSync(join(project, "base.txt"), "base\n");
  git(project, "add", "base.txt");
  git(project, "commit", "-m", "base");
  git(project, "remote", "add", "origin", remote);
  git(project, "push", "-u", "origin", "main");
  return project;
}

describe("Git parsers", () => {
  test("parses worktree porcelain including detached and prunable records", () => {
    const records = parseWorktrees(
      "worktree /code/main\0HEAD abc\0branch refs/heads/main\0\0" +
        "worktree /tmp/peer\nwith-newline\0HEAD def\0detached\0prunable missing\0\0",
    );
    expect(records).toEqual([
      { path: "/code/main", head: "abc", branch: "main", detached: false, prunable: false },
      {
        path: "/tmp/peer\nwith-newline",
        head: "def",
        branch: null,
        detached: true,
        prunable: true,
      },
    ]);
  });

  test("parses staged, unstaged, conflict, and untracked status separately", () => {
    const output =
      "1 .M N... 100644 100644 100644 abc def tracked file.txt\0" +
      "1 A. N... 000000 100644 100644 000 def staged.txt\0" +
      "u UU N... 100644 100644 100644 100644 a b c conflict.txt\0" +
      "? new file.txt\0";
    expect(parseStatus(output)).toEqual([
      {
        path: "tracked file.txt",
        staged: false,
        unstaged: true,
        conflict: false,
        untracked: false,
      },
      {
        path: "staged.txt",
        staged: true,
        unstaged: false,
        conflict: false,
        untracked: false,
      },
      {
        path: "conflict.txt",
        staged: false,
        unstaged: false,
        conflict: true,
        untracked: false,
      },
      {
        path: "new file.txt",
        staged: false,
        unstaged: false,
        conflict: false,
        untracked: true,
      },
    ]);
  });

  test("parses text and binary numstats", () => {
    const stats = parseNumstat("12\t3\tsrc/a.ts\0-\t-\timage.png\0");
    expect(stats.additions).toBe(12);
    expect(stats.deletions).toBe(3);
    expect([...stats.paths]).toEqual(["src/a.ts", "image.png"]);
    expect([...stats.binaryPaths]).toEqual(["image.png"]);
  });
});

test("separate Git directories are recognized as primary checkouts", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-separate-git-"));
  try {
    const projects = join(fixture, "code");
    const project = join(projects, "separate");
    const gitDirectory = join(fixture, "metadata", "separate.git");
    mkdirSync(projects);
    mkdirSync(project);
    mkdirSync(join(fixture, "metadata"));
    git(project, "init", "-b", "main", `--separate-git-dir=${gitDirectory}`);
    writeFileSync(join(project, "base.txt"), "base\n");
    git(project, "add", "base.txt");
    git(project, "commit", "-m", "base");
    appendFileSync(join(project, "base.txt"), "working\n");

    const result = await scanProjects({ root: projects, herdr: EMPTY_HERDR });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.primaryWorking.files).toBe(1);
    expect(result.projects[0]?.worktrees).toHaveLength(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a linked-only separate-Git-dir project remains observable without treating metadata as a checkout", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-linked-separate-git-"));
  try {
    const projects = join(fixture, "code");
    const primary = join(fixture, "primary");
    const gitDirectory = join(fixture, "metadata", "project.git");
    const linked = join(projects, "linked-only");
    mkdirSync(projects);
    mkdirSync(primary);
    mkdirSync(join(fixture, "metadata"));
    git(primary, "init", "-b", "main", `--separate-git-dir=${gitDirectory}`);
    writeFileSync(join(primary, "base.txt"), "base\n");
    git(primary, "add", "base.txt");
    git(primary, "commit", "-m", "base");
    git(primary, "worktree", "add", "-b", "feature", linked);
    appendFileSync(join(linked, "base.txt"), "linked change\n");

    const result = await scanProjects({ root: projects, herdr: EMPTY_HERDR });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]?.worktrees).toHaveLength(1);
    expect(result.projects[0]?.worktrees[0]?.working.files).toBe(1);
    expect(result.diagnostics.join("\n")).not.toContain("must be run in a work tree");
    expect(result.diagnostics.join("\n")).toContain(
      "does not record the location of its primary checkout",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("scan aggregates a project and classifies its linked worktree against configured primary", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-git-"));
  try {
    const projects = join(fixture, "code");
    const worktrees = join(fixture, "worktrees");
    mkdirSync(projects);
    mkdirSync(worktrees);
    const project = createPushedProject(projects, "active project");
    createPushedProject(projects, "quiet");
    git(project, "branch", "-m", "integration");
    git(project, "config", "supervisor.trunk", "integration");

    const linked = join(worktrees, "feature tree");
    git(project, "worktree", "add", "-b", "feature", linked);
    writeFileSync(join(linked, "feature.txt"), "one\ntwo\n");
    git(linked, "add", "feature.txt");
    git(linked, "commit", "-m", "feature work");
    appendFileSync(join(project, "base.txt"), "working\n");
    writeFileSync(join(project, "untracked.txt"), "not counted as additions\n");
    const primaryIndex = join(project, ".git", "index");
    const linkedIndex = git(linked, "rev-parse", "--git-path", "index");
    const primaryIndexBefore = readFileSync(primaryIndex);
    const linkedIndexBefore = readFileSync(linkedIndex);

    const result = await scanProjects({ root: projects, herdr: EMPTY_HERDR });
    expect(readFileSync(primaryIndex)).toEqual(primaryIndexBefore);
    expect(readFileSync(linkedIndex)).toEqual(linkedIndexBefore);
    expect(result.projects.map((entry) => entry.name)).toEqual(["active project"]);
    const active = result.projects[0];
    expect(active?.primaryBranch).toBe("integration");
    expect(active?.primaryWorking).toMatchObject({
      files: 2,
      additions: 1,
      deletions: 0,
      unstaged: 1,
      untracked: 1,
    });
    expect(active?.unpushed).toMatchObject({ commits: 1, files: 1, additions: 2, deletions: 0 });
    expect(active?.worktrees).toHaveLength(1);
    expect(active?.worktrees[0]).toMatchObject({
      branch: "feature",
      working: { files: 0 },
      ahead: 1,
      behind: 0,
      mergeState: "unmerged",
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("an otherwise quiet project remains observable while a Herdr agent is present", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-agent-only-"));
  try {
    const projects = join(fixture, "code");
    mkdirSync(projects);
    const project = createPushedProject(projects, "agent-only");
    const herdr: HerdrRunner = async (args) => ({
      code: 0,
      stdout: JSON.stringify({
        id: `cli:${args[0]}:list`,
        result:
          args[0] === "agent"
            ? {
                type: "agent_list",
                agents: [
                  {
                    agent: "codex",
                    agent_status: "idle",
                    cwd: project,
                    focused: false,
                    pane_id: "w1:p1",
                    tab_id: "w1:t1",
                    workspace_id: "w1",
                    tokens: { conversation: "quiet-project-work" },
                  },
                ],
              }
            : {
                type: "workspace_list",
                workspaces: [{ workspace_id: "w1", worktree: { checkout_path: project } }],
              },
      }),
      stderr: "",
    });

    const result = await scanProjects({ root: projects, herdr });
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      name: "agent-only",
      primaryWorking: { files: 0 },
      unpushed: { commits: 0 },
      worktrees: [],
      agents: [{ agent: "codex", status: "idle", conversation: "quiet-project-work" }],
    });
    expect(result.agentPresence).toEqual({ available: true, diagnostics: [] });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
