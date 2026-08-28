import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult } from "../src/git.ts";
import {
  ciChannel,
  createCiProjectionStore,
  deliveryAffectsCi,
  fetchCiProjections,
  projectKey,
} from "../src/github-ci.ts";
import type { GitHubProject } from "../src/github-webhooks.ts";
import type { CiProjection, WebhookDelivery } from "../src/types.ts";

const ok = (value: unknown): GitResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});

function repository(
  state: string | null,
  nodes: unknown[] = [],
  pageInfo = { hasNextPage: false, endCursor: null as string | null },
): unknown {
  return {
    defaultBranchRef: {
      name: "main",
      target: {
        oid: "abc123",
        committedDate: "2026-08-27T19:58:00Z",
        statusCheckRollup:
          state === null
            ? null
            : {
                state,
                contexts: { nodes, pageInfo },
              },
      },
    },
  };
}

function delivery(event: string, payload: unknown): WebhookDelivery {
  return {
    schemaVersion: 1,
    receivedAt: "2026-08-27T20:00:00Z",
    owner: "Possibilities",
    repo: "AgentSource",
    event,
    deliveryId: "delivery-1",
    hookId: null,
    payload,
  };
}

function baseProjection(): CiProjection {
  return {
    schemaVersion: 2,
    revision: 1,
    projectedAt: "2026-08-27T20:00:00Z",
    owner: "possibilities",
    repo: "agentsource",
    paths: ["/code/agentsource"],
    available: true,
    defaultBranch: "main",
    primaryBranch: "main",
    heads: [
      {
        sha: "abc123",
        committedAt: "2026-08-27T19:58:00Z",
        aggregateState: "PENDING",
        contexts: [],
        diagnostics: [],
      },
    ],
    targets: [{ kind: "branch", branch: "main", role: "primary", headSha: "abc123" }],
    diagnostics: [],
  };
}

test("CI channel identity is canonical and type-first", () => {
  expect(ciChannel("Possibilities", "AgentSource")).toBe("ci:possibilities:agentsource");
  expect(projectKey("Possibilities", "AgentSource")).toBe("possibilities/agentsource");
});

test("hydrates every project in one GitHub query and preserves check/status detail", async () => {
  const projects: GitHubProject[] = [
    { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] },
    { owner: "possibilities", repo: "agentstart", paths: ["/code/agentstart"] },
  ];
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  const projections = await fetchCiProjections(
    projects,
    new Map(projects.map((project) => [projectKey(project.owner, project.repo), 1])),
    async (args) => {
      mutableCalls.push([...args]);
      return ok({
        data: {
          p0: repository("PENDING", [
            {
              __typename: "CheckRun",
              name: "build",
              status: "IN_PROGRESS",
              conclusion: null,
              detailsUrl: "https://github.com/check/1",
              startedAt: "2026-08-27T19:59:00Z",
              completedAt: null,
              checkSuite: { app: { name: "GitHub Actions" } },
            },
            {
              __typename: "StatusContext",
              context: "deploy",
              state: "SUCCESS",
              description: "ready",
              targetUrl: "https://example.test/deploy",
              createdAt: "2026-08-27T19:59:30Z",
            },
          ]),
          p1: repository(null),
        },
      });
    },
    () => new Date("2026-08-27T20:00:00Z"),
  );

  expect(calls).toHaveLength(1);
  expect(calls[0]?.join(" ")).toContain("p0: repository");
  expect(calls[0]?.join(" ")).toContain("p1: repository");
  expect(projections[0]).toMatchObject({
    available: true,
    defaultBranch: "main",
    heads: [
      {
        sha: "abc123",
        aggregateState: "PENDING",
        contexts: [
          { kind: "check-run", name: "build", app: "GitHub Actions" },
          { kind: "status", name: "deploy", state: "SUCCESS" },
        ],
      },
    ],
  });
  expect(projections[1]).toMatchObject({
    available: true,
    heads: [{ aggregateState: "NONE" }],
  });
});

test("paginates CI contexts and degrades only a repository with GraphQL errors", async () => {
  const projects: GitHubProject[] = [
    { owner: "possibilities", repo: "one", paths: ["/code/one"] },
    { owner: "possibilities", repo: "private", paths: ["/code/private"] },
  ];
  let calls = 0;
  const projections = await fetchCiProjections(
    projects,
    new Map([
      ["possibilities/one", 4],
      ["possibilities/private", 2],
    ]),
    async () => {
      calls += 1;
      if (calls === 1)
        return ok({
          data: {
            p0: repository(
              "SUCCESS",
              [
                {
                  __typename: "StatusContext",
                  context: "first",
                  state: "SUCCESS",
                },
              ],
              { hasNextPage: true, endCursor: "cursor-1" },
            ),
            p1: null,
          },
          errors: [{ message: "resource not accessible", path: ["p1"] }],
        });
      const next = repository("SUCCESS", [
        { __typename: "StatusContext", context: "second", state: "SUCCESS" },
      ]) as { defaultBranchRef: { target: unknown } };
      return ok({
        data: {
          repository: { object: next.defaultBranchRef.target },
        },
      });
    },
  );

  expect(calls).toBe(2);
  expect(projections[0]).toMatchObject({
    revision: 4,
    available: true,
    heads: [{ contexts: [{ name: "first" }, { name: "second" }] }],
  });
  expect(projections[1]).toMatchObject({
    revision: 2,
    available: false,
    heads: [],
  });
  expect(projections[1]?.diagnostics).toContainEqual(
    expect.stringContaining("resource not accessible"),
  );
});

test("classifies registered-project CI events as relevant", () => {
  const projection = baseProjection();
  expect(deliveryAffectsCi(delivery("push", { ref: "refs/heads/main" }), projection)).toBe(true);
  expect(deliveryAffectsCi(delivery("push", { ref: "refs/heads/topic" }), projection)).toBe(true);
  expect(
    deliveryAffectsCi(delivery("check_run", { check_run: { head_sha: "abc123" } }), projection),
  ).toBe(true);
  expect(deliveryAffectsCi(delivery("status", { sha: "other" }), projection)).toBe(true);
  expect(deliveryAffectsCi(delivery("issues", {}), projection)).toBe(false);
});

test("refreshes and emits only the affected registered project", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentsource-ci-store-"));
  const projectPath = join(root, "agentsource");
  mkdirSync(projectPath);
  let ghCalls = 0;
  try {
    const store = await createCiProjectionStore({
      root,
      refreshDelayMs: 0,
      now: () => new Date("2026-08-27T20:00:00Z"),
      git: async (_cwd, args) => {
        if (args[0] === "remote")
          return { code: 0, stdout: "git@github.com:possibilities/agentsource.git\n", stderr: "" };
        if (args[0] === "config") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "worktree")
          return {
            code: 0,
            stdout: `worktree ${projectPath}\0HEAD abc123\0branch refs/heads/main\0\0`,
            stderr: "",
          };
        return {
          code: 0,
          stdout: args[1] === "--show-toplevel" ? `${projectPath}\n` : "abc123\n",
          stderr: "",
        };
      },
      gh: async () => {
        ghCalls += 1;
        const value = repository(ghCalls === 1 ? "PENDING" : "SUCCESS") as Record<string, unknown>;
        const target = (value.defaultBranchRef as { target: unknown }).target;
        return ok({
          data: {
            p0: { ...value, h0: target },
          },
        });
      },
    });
    expect(store.list()).toEqual([]);
    expect(ghCalls).toBe(0);
    expect(await store.snapshot(["ci:possibilities:agentsource"])).toMatchObject([
      { revision: 1, heads: [{ aggregateState: "PENDING" }] },
    ]);
    expect(ghCalls).toBe(1);
    await store.snapshot(["ci:*"]);
    expect(ghCalls).toBe(1);
    const updated = new Promise<CiProjection>((resolve) => store.onUpdate(resolve));
    store.handleDelivery(delivery("status", { sha: "abc123" }));
    expect(await updated).toMatchObject({
      revision: 2,
      heads: [{ aggregateState: "SUCCESS" }],
    });
    expect(ghCalls).toBe(2);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a slow first hydration cannot overwrite a webhook refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentsource-ci-race-"));
  const projectPath = join(root, "agentsource");
  mkdirSync(projectPath);
  const pending: Array<(result: GitResult) => void> = [];
  const localGit = async (_cwd: string, args: readonly string[]): Promise<GitResult> => {
    if (args[0] === "remote")
      return { code: 0, stdout: "git@github.com:possibilities/agentsource.git\n", stderr: "" };
    if (args[0] === "config") return { code: 1, stdout: "", stderr: "" };
    if (args[0] === "worktree")
      return {
        code: 0,
        stdout: `worktree ${projectPath}\0HEAD abc123\0branch refs/heads/main\0\0`,
        stderr: "",
      };
    return {
      code: 0,
      stdout: args[1] === "--show-toplevel" ? `${projectPath}\n` : "abc123\n",
      stderr: "",
    };
  };
  const response = (state: "PENDING" | "SUCCESS"): GitResult => {
    const value = repository(state) as Record<string, unknown>;
    const target = (value.defaultBranchRef as { target: unknown }).target;
    return ok({ data: { p0: { ...value, h0: target } } });
  };
  try {
    const store = await createCiProjectionStore({
      root,
      refreshDelayMs: 0,
      git: localGit,
      gh: async () => await new Promise<GitResult>((resolve) => pending.push(resolve)),
    });
    const first = store.snapshot(["ci:*"]);
    while (pending.length < 1) await Bun.sleep(0);
    const updated = new Promise<CiProjection>((resolve) => store.onUpdate(resolve));
    store.handleDelivery(delivery("status", { sha: "abc123" }));
    while (pending.length < 2) await Bun.sleep(0);
    pending[1]?.(response("SUCCESS"));
    expect(await updated).toMatchObject({ heads: [{ aggregateState: "SUCCESS" }] });
    pending[0]?.(response("PENDING"));
    expect(await first).toMatchObject([{ heads: [{ aggregateState: "SUCCESS" }] }]);
    await store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
