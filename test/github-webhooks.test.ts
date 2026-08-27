import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitResult } from "../src/git.ts";
import {
  discoverGitHubProjects,
  type GhRunner,
  normalizeWebhookBaseUrl,
  parseGitHubRemote,
  parseSetupArgs,
  reconcileGitHubWebhook,
} from "../src/github-webhooks.ts";

const ok = (stdout: string): GitResult => ({ code: 0, stdout, stderr: "" });

test("parses common github.com origin spellings", () => {
  expect(parseGitHubRemote("git@github.com:possibilities/agentsource.git")).toEqual({
    owner: "possibilities",
    repo: "agentsource",
  });
  expect(parseGitHubRemote("https://github.com/possibilities/agentsource.git")).toEqual({
    owner: "possibilities",
    repo: "agentsource",
  });
  expect(parseGitHubRemote("ssh://git@github.com/possibilities/agentsource")).toEqual({
    owner: "possibilities",
    repo: "agentsource",
  });
  expect(parseGitHubRemote("https://gitlab.com/possibilities/agentsource.git")).toBeNull();
  expect(parseGitHubRemote("https://github.com/too/many/segments.git")).toBeNull();
});

test("discovers and deduplicates GitHub projects directly below the chosen root", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentsource-github-projects-"));
  try {
    for (const name of ["one", "duplicate", "local", "not-a-project"]) mkdirSync(join(root, name));
    const remotes: Record<string, string> = {
      one: "git@github.com:possibilities/one.git\n",
      duplicate: "https://github.com/possibilities/one.git\n",
      local: "/tmp/local.git\n",
    };
    const discovery = await discoverGitHubProjects(root, async (cwd, args) => {
      const name = cwd.slice(cwd.lastIndexOf("/") + 1);
      if (name === "not-a-project") return { code: 128, stdout: "", stderr: "not a repo" };
      if (args[0] === "rev-parse") return ok(`${cwd}\n`);
      return ok(remotes[name] ?? "");
    });
    expect(discovery.projects).toHaveLength(1);
    expect(discovery.projects[0]).toMatchObject({ owner: "possibilities", repo: "one" });
    expect(discovery.projects[0]?.paths).toHaveLength(2);
    expect(discovery.diagnostics).toEqual([
      `${join(root, "local")}: origin is not a github.com project; skipped`,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes a Funnel origin and parses dry-run/apply setup arguments", () => {
  expect(normalizeWebhookBaseUrl("https://machine.tailnet.ts.net")).toBe(
    "https://machine.tailnet.ts.net",
  );
  expect(() => normalizeWebhookBaseUrl("http://machine.tailnet.ts.net")).toThrow("HTTPS origin");
  expect(() => normalizeWebhookBaseUrl("https://machine.tailnet.ts.net/hooks")).toThrow(
    "HTTPS origin",
  );
  expect(
    parseSetupArgs([
      "--url",
      "https://machine.tailnet.ts.net",
      "--secret-file",
      "/tmp/secret",
      "--previous-url",
      "https://old-machine.tailnet.ts.net",
      "--root",
      "/tmp/code",
      "--apply",
    ]),
  ).toEqual({
    mode: "run",
    root: "/tmp/code",
    baseUrl: "https://machine.tailnet.ts.net",
    previousBaseUrl: "https://old-machine.tailnet.ts.net",
    secretFile: "/tmp/secret",
    apply: true,
  });
});

test("creates or updates the exact project webhook without exposing the secret in arguments", async () => {
  const project = { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] };
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const createGh: GhRunner = async (args, input) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return calls.length === 1 ? ok("[]") : ok("{}");
  };
  const created = await reconcileGitHubWebhook({
    project,
    baseUrl: "https://machine.tailnet.ts.net",
    secret: "super-secret-value",
    apply: true,
    gh: createGh,
  });
  expect(created.action).toBe("created");
  expect(calls[1]?.args).toEqual([
    "api",
    "--method",
    "POST",
    "repos/possibilities/agentsource/hooks",
    "--input",
    "-",
  ]);
  expect(calls[1]?.args.join(" ")).not.toContain("super-secret-value");
  expect(JSON.parse(calls[1]?.input ?? "{}")).toMatchObject({
    name: "web",
    active: true,
    events: ["*"],
    config: {
      url: "https://machine.tailnet.ts.net/possibilities/agentsource",
      content_type: "json",
      secret: "super-secret-value",
      insecure_ssl: "0",
    },
  });

  const updateCalls: Array<{ args: readonly string[]; input?: string }> = [];
  const updateGh: GhRunner = async (args, input) => {
    updateCalls.push({ args, ...(input === undefined ? {} : { input }) });
    return updateCalls.length === 1
      ? ok(
          JSON.stringify([
            {
              id: 987,
              config: { url: "https://machine.tailnet.ts.net/possibilities/agentsource" },
            },
          ]),
        )
      : ok("{}");
  };
  const updated = await reconcileGitHubWebhook({
    project,
    baseUrl: "https://machine.tailnet.ts.net",
    secret: "super-secret-value",
    apply: true,
    gh: updateGh,
  });
  expect(updated.action).toBe("updated");
  expect(updateCalls[1]?.args).toContain("repos/possibilities/agentsource/hooks/987");
});

test("dry-run inspects GitHub but does not mutate it", async () => {
  const project = { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] };
  let calls = 0;
  const result = await reconcileGitHubWebhook({
    project,
    baseUrl: "https://machine.tailnet.ts.net",
    secret: "not-sent",
    apply: false,
    gh: async () => {
      calls += 1;
      return ok("[]");
    },
  });
  expect(result.action).toBe("would-create");
  expect(calls).toBe(1);
});

test("updates the existing hook when the Funnel hostname changes explicitly", async () => {
  const project = { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] };
  const calls: Array<{ args: readonly string[]; input?: string }> = [];
  const result = await reconcileGitHubWebhook({
    project,
    baseUrl: "https://new-machine.tailnet.ts.net",
    previousBaseUrl: "https://old-machine.tailnet.ts.net",
    secret: "stable-secret",
    apply: true,
    gh: async (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      return calls.length === 1
        ? ok(
            JSON.stringify([
              {
                id: 123,
                config: { url: "https://old-machine.tailnet.ts.net/possibilities/agentsource" },
              },
            ]),
          )
        : ok("{}");
    },
  });
  expect(result.action).toBe("updated");
  expect(calls[1]?.args).toContain("repos/possibilities/agentsource/hooks/123");
  expect(JSON.parse(calls[1]?.input ?? "{}").config.url).toBe(
    "https://new-machine.tailnet.ts.net/possibilities/agentsource",
  );
});

test("refuses an ambiguous current and previous hook instead of mutating either", async () => {
  const project = { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] };
  let calls = 0;
  await expect(
    reconcileGitHubWebhook({
      project,
      baseUrl: "https://new-machine.tailnet.ts.net",
      previousBaseUrl: "https://old-machine.tailnet.ts.net",
      secret: "stable-secret",
      apply: true,
      gh: async () => {
        calls += 1;
        return ok(
          JSON.stringify([
            {
              id: 1,
              config: { url: "https://new-machine.tailnet.ts.net/possibilities/agentsource" },
            },
            {
              id: 2,
              config: { url: "https://old-machine.tailnet.ts.net/possibilities/agentsource" },
            },
          ]),
        );
      },
    }),
  ).rejects.toThrow("multiple webhooks match");
  expect(calls).toBe(1);
});

test("redacts the webhook secret from failed gh mutation output", async () => {
  const project = { owner: "possibilities", repo: "agentsource", paths: ["/code/agentsource"] };
  const secret = 'secret-with-"-quote';
  let calls = 0;
  let message = "";
  try {
    await reconcileGitHubWebhook({
      project,
      baseUrl: "https://machine.tailnet.ts.net",
      secret,
      apply: true,
      gh: async () => {
        calls += 1;
        return calls === 1
          ? ok("[]")
          : {
              code: 1,
              stdout: "",
              stderr: `request body secret=${secret} json=${JSON.stringify(secret)}`,
            };
      },
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("[REDACTED]");
  expect(message).not.toContain(secret);
  expect(message).not.toContain(JSON.stringify(secret).slice(1, -1));
});
