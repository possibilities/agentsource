import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type GitResult, type GitRunner, runGit } from "./git.ts";
import { renderWebhookConfigureHelp } from "./guide.ts";
import { readWebhookSecret } from "./webhooks.ts";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

export interface GitHubProject {
  owner: string;
  repo: string;
  paths: string[];
}

export interface GitHubProjectDiscovery {
  projects: GitHubProject[];
  diagnostics: string[];
}

export type GhRunner = (args: readonly string[], input?: string) => Promise<GitResult>;

export interface ReconcileResult {
  project: GitHubProject;
  url: string;
  action: "created" | "updated" | "unchanged" | "would-create" | "would-update";
}

interface SetupInvocation {
  mode: "run" | "help";
  root?: string;
  baseUrl?: string;
  previousBaseUrl?: string;
  secretFile?: string;
  apply: boolean;
}

interface GitHubHook {
  id: number;
  active?: boolean;
  events?: string[];
  config?: { url?: string; content_type?: string; insecure_ssl?: string };
}

export function parseGitHubRemote(remote: string): { owner: string; repo: string } | null {
  const trimmed = remote.trim().replace(/\/$/, "");
  let match = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (!match) {
    match = trimmed.match(/^(?:https|ssh|git):\/\/(?:git@)?github\.com\/([^/]+)\/([^/]+)$/i);
  }
  const owner = match?.[1];
  const rawRepo = match?.[2];
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

async function directProjectCandidates(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const candidates: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
  return candidates;
}

export async function discoverGitHubProjects(
  root: string,
  git: GitRunner = runGit,
): Promise<GitHubProjectDiscovery> {
  const projects = new Map<string, GitHubProject>();
  const diagnostics: string[] = [];
  for (const candidate of await directProjectCandidates(root)) {
    const top = await git(candidate, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || top.stdout.trim() === "") continue;
    let candidatePath: string;
    let topPath: string;
    try {
      [candidatePath, topPath] = await Promise.all([
        realpath(candidate),
        realpath(top.stdout.trim()),
      ]);
    } catch {
      continue;
    }
    if (candidatePath !== topPath) continue;
    const origin = await git(candidate, ["remote", "get-url", "origin"]);
    if (origin.code !== 0 || origin.stdout.trim() === "") {
      diagnostics.push(`${candidate}: no origin remote; skipped`);
      continue;
    }
    const identity = parseGitHubRemote(origin.stdout);
    if (!identity) {
      diagnostics.push(`${candidate}: origin is not a github.com project; skipped`);
      continue;
    }
    const key = `${identity.owner}/${identity.repo}`.toLowerCase();
    const existing = projects.get(key);
    if (existing) existing.paths.push(candidatePath);
    else projects.set(key, { ...identity, paths: [candidatePath] });
  }
  return {
    projects: [...projects.values()].sort((left, right) =>
      `${left.owner}/${left.repo}`.localeCompare(`${right.owner}/${right.repo}`),
    ),
    diagnostics,
  };
}

export function normalizeWebhookBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--url must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ts.net") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "--url must be a Tailscale HTTPS origin ending in .ts.net, with no path, credentials, query, or fragment",
    );
  }
  return url.origin;
}

export async function runGh(args: readonly string[], input?: string): Promise<GitResult> {
  return await new Promise((resolveResult) => {
    const environment = { ...process.env };
    delete environment.GH_DEBUG;
    const child = spawn("gh", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
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
    const timer = setTimeout(() => child.kill("SIGTERM"), 30_000);
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
    child.stdin.end(input);
  });
}

function redactSecret(value: string, secret: string): string {
  const jsonEscaped = JSON.stringify(secret).slice(1, -1);
  return value.split(secret).join("[REDACTED]").split(jsonEscaped).join("[REDACTED]");
}

function parseHookList(output: string, project: GitHubProject): GitHubHook[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
  }
  if (!Array.isArray(value))
    throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
  const hooks: GitHubHook[] = [];
  for (const hook of value) {
    if (typeof hook !== "object" || hook === null)
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    const id = Reflect.get(hook, "id");
    const active = Reflect.get(hook, "active");
    const events = Reflect.get(hook, "events");
    const rawConfig = Reflect.get(hook, "config");
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof rawConfig !== "object" ||
      rawConfig === null
    ) {
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    }
    const rawUrl = Reflect.get(rawConfig, "url");
    const contentType = Reflect.get(rawConfig, "content_type");
    const insecureSsl = Reflect.get(rawConfig, "insecure_ssl");
    if (rawUrl !== undefined && typeof rawUrl !== "string")
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    if (active !== undefined && typeof active !== "boolean")
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    if (
      events !== undefined &&
      (!Array.isArray(events) || events.some((event) => typeof event !== "string"))
    )
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    if (contentType !== undefined && typeof contentType !== "string")
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    if (insecureSsl !== undefined && typeof insecureSsl !== "string")
      throw new Error(`${project.owner}/${project.repo}: GitHub returned malformed hook data`);
    hooks.push({
      id,
      ...(active === undefined ? {} : { active }),
      ...(events === undefined ? {} : { events: [...events] }),
      config: {
        ...(rawUrl === undefined ? {} : { url: rawUrl }),
        ...(contentType === undefined ? {} : { content_type: contentType }),
        ...(insecureSsl === undefined ? {} : { insecure_ssl: insecureSsl }),
      },
    });
  }
  return hooks;
}

export async function reconcileGitHubWebhook(options: {
  project: GitHubProject;
  baseUrl: string;
  previousBaseUrl?: string;
  secret: string;
  apply: boolean;
  gh?: GhRunner;
}): Promise<ReconcileResult> {
  const gh = options.gh ?? runGh;
  const { project } = options;
  const url = `${options.baseUrl}/${project.owner}/${project.repo}`;
  const previousUrl = options.previousBaseUrl
    ? `${options.previousBaseUrl}/${project.owner}/${project.repo}`
    : null;
  const endpoint = `repos/${project.owner}/${project.repo}/hooks`;
  const listed = await gh(["api", `${endpoint}?per_page=100`]);
  if (listed.code !== 0) {
    throw new Error(
      `${project.owner}/${project.repo}: could not list webhooks: ${listed.stderr.trim() || `gh exited ${listed.code}`}`,
    );
  }
  const matches = parseHookList(listed.stdout, project).filter(
    (hook) =>
      hook.config?.url === url || (previousUrl !== null && hook.config?.url === previousUrl),
  );
  if (matches.length > 1)
    throw new Error(
      `${project.owner}/${project.repo}: multiple webhooks match the current or previous URL`,
    );
  const existing = matches[0];
  if (!options.apply) {
    const correct =
      existing?.active === true &&
      existing.events?.length === 1 &&
      existing.events[0] === "*" &&
      existing.config?.content_type === "json" &&
      existing.config.insecure_ssl === "0";
    return {
      project,
      url,
      action: correct ? "unchanged" : existing ? "would-update" : "would-create",
    };
  }

  const config = {
    url,
    content_type: "json",
    secret: options.secret,
    insecure_ssl: "0",
  };
  const body = existing
    ? { active: true, events: ["*"], config }
    : { name: "web", active: true, events: ["*"], config };
  const changed = await gh(
    existing
      ? ["api", "--method", "PATCH", `${endpoint}/${existing.id}`, "--input", "-"]
      : ["api", "--method", "POST", endpoint, "--input", "-"],
    JSON.stringify(body),
  );
  if (changed.code !== 0) {
    const detail = redactSecret(changed.stderr.trim(), options.secret);
    throw new Error(
      `${project.owner}/${project.repo}: could not ${existing ? "update" : "create"} webhook: ${detail || `gh exited ${changed.code}`}`,
    );
  }
  return { project, url, action: existing ? "updated" : "created" };
}

export function parseSetupArgs(args: readonly string[]): SetupInvocation {
  let root = join(homedir(), "code");
  let baseUrl: string | undefined;
  let previousBaseUrl: string | undefined;
  let secretFile: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { mode: "help", apply: false };
    if (arg === "--apply") apply = true;
    else if (
      arg === "--root" ||
      arg === "--url" ||
      arg === "--previous-url" ||
      arg === "--secret-file"
    ) {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--root") root = resolve(value);
      else if (arg === "--url") baseUrl = normalizeWebhookBaseUrl(value);
      else if (arg === "--previous-url") previousBaseUrl = normalizeWebhookBaseUrl(value);
      else secretFile = resolve(value);
      index += 1;
    } else if (arg?.startsWith("--root=")) root = resolve(arg.slice("--root=".length));
    else if (arg?.startsWith("--url="))
      baseUrl = normalizeWebhookBaseUrl(arg.slice("--url=".length));
    else if (arg?.startsWith("--previous-url="))
      previousBaseUrl = normalizeWebhookBaseUrl(arg.slice("--previous-url=".length));
    else if (arg?.startsWith("--secret-file="))
      secretFile = resolve(arg.slice("--secret-file=".length));
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!baseUrl) throw new Error("--url is required");
  if (!secretFile) throw new Error("--secret-file is required");
  return {
    mode: "run",
    root,
    baseUrl,
    ...(previousBaseUrl ? { previousBaseUrl } : {}),
    secretFile,
    apply,
  };
}

function setupUsage(): string {
  return renderWebhookConfigureHelp();
}

export async function runGitHubWebhookSetupCli(args = process.argv.slice(2)): Promise<number> {
  let invocation: SetupInvocation;
  try {
    invocation = parseSetupArgs(args);
  } catch (error) {
    process.stderr.write(
      `agentsource webhook-configure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.stderr.write(setupUsage());
    return 2;
  }
  if (invocation.mode === "help") {
    process.stdout.write(setupUsage());
    return 0;
  }
  try {
    const secretBytes = await readWebhookSecret(invocation.secretFile as string);
    const secret = secretBytes.toString("utf8");
    const discovery = await discoverGitHubProjects(invocation.root as string);
    for (const diagnostic of discovery.diagnostics)
      process.stderr.write(`agentsource webhook-configure: ${diagnostic}\n`);
    let failures = 0;
    for (const project of discovery.projects) {
      try {
        const result = await reconcileGitHubWebhook({
          project,
          baseUrl: invocation.baseUrl as string,
          ...(invocation.previousBaseUrl ? { previousBaseUrl: invocation.previousBaseUrl } : {}),
          secret,
          apply: invocation.apply,
        });
        process.stdout.write(
          `${result.action} ${project.owner}/${project.repo} ${result.url}` +
            `${project.paths.length > 1 ? ` (${project.paths.length} local checkouts)` : ""}\n`,
        );
      } catch (error) {
        failures += 1;
        process.stderr.write(
          `agentsource webhook-configure: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    return failures === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `agentsource webhook-configure: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}
