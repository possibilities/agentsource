import type { GitResult, GitRunner } from "./git.ts";
import { parseWorktrees, runGit } from "./git.ts";
import {
  discoverGitHubProjects,
  type GhRunner,
  type GitHubProject,
  type GitHubProjectDiscovery,
  runGh,
} from "./github-webhooks.ts";
import {
  CI_PROJECTION_SCHEMA_VERSION,
  type CiAggregateState,
  type CiContext,
  type CiHead,
  type CiProjection,
  type CiTarget,
  type GitHubRepositoryVisibility,
  type WebhookDelivery,
} from "./types.ts";

const CONTEXT_PAGE_SIZE = 100;
const MAX_CONTEXT_PAGES = 100;
const DEFAULT_REFRESH_DELAY_MS = 500;
const AGGREGATE_STATES = new Set<CiAggregateState>([
  "ERROR",
  "EXPECTED",
  "FAILURE",
  "PENDING",
  "SUCCESS",
]);

type ProjectionListener = (projection: CiProjection) => void;

export interface CiProjectionStore {
  diagnostics: readonly string[];
  list: () => readonly CiProjection[];
  snapshot: (channels: readonly string[]) => Promise<readonly CiProjection[]>;
  onUpdate: (listener: ProjectionListener) => () => void;
  handleDelivery: (delivery: WebhookDelivery) => void;
  close: () => Promise<void>;
}

export interface CreateCiProjectionStoreOptions {
  root: string;
  gh?: GhRunner;
  git?: GitRunner;
  now?: () => Date;
  refreshDelayMs?: number;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ParsedCommit {
  head: CiHead;
  pageInfo: PageInfo;
}

interface ProjectInput {
  project: GitHubProject;
  primaryBranch: string;
  localShas: string[];
  targets: CiTarget[];
  diagnostics: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function repositoryVisibility(value: unknown): GitHubRepositoryVisibility | null {
  return value === "PRIVATE" || value === "PUBLIC" || value === "INTERNAL" ? value : null;
}

function commitFields(after?: string): string {
  const afterArgument = after === undefined ? "" : `, after: ${JSON.stringify(after)}`;
  return `
    ... on Commit {
      oid
      committedDate
      statusCheckRollup {
        state
        contexts(first: ${CONTEXT_PAGE_SIZE}${afterArgument}) {
          nodes {
            __typename
            ... on CheckRun {
              name status conclusion detailsUrl startedAt completedAt
              checkSuite { app { name } }
            }
            ... on StatusContext { context state description targetUrl createdAt }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`;
}

function batchQuery(inputs: readonly ProjectInput[]): string {
  const repositories = inputs.map((input, projectIndex) => {
    const objects = input.localShas.map(
      (sha, headIndex) =>
        `h${headIndex}: object(expression: ${JSON.stringify(sha)}) {${commitFields()}\n    }`,
    );
    return `p${projectIndex}: repository(owner: ${JSON.stringify(input.project.owner)}, name: ${JSON.stringify(input.project.repo)}) {
    visibility
    defaultBranchRef { name target {${commitFields()}\n      } }
    ${objects.join("\n    ")}
  }`;
  });
  return `query AgentsourceCi {\n  ${repositories.join("\n  ")}\n}`;
}

function pageQuery(project: GitHubProject, sha: string, after: string): string {
  return `query AgentsourceCiPage {
  repository(owner: ${JSON.stringify(project.owner)}, name: ${JSON.stringify(project.repo)}) {
    object(expression: ${JSON.stringify(sha)}) {${commitFields(after)}\n    }
  }
}`;
}

function parseContext(value: unknown, diagnostics: string[]): CiContext | null {
  const node = record(value);
  if (!node) return null;
  if (node.__typename === "CheckRun") {
    const name = stringOrNull(node.name);
    const status = stringOrNull(node.status);
    if (!name || !status) {
      diagnostics.push("GitHub returned an incomplete check run");
      return null;
    }
    return {
      kind: "check-run",
      name,
      status,
      conclusion: stringOrNull(node.conclusion),
      detailsUrl: stringOrNull(node.detailsUrl),
      app: stringOrNull(record(record(node.checkSuite)?.app)?.name),
      startedAt: stringOrNull(node.startedAt),
      completedAt: stringOrNull(node.completedAt),
    };
  }
  if (node.__typename === "StatusContext") {
    const name = stringOrNull(node.context);
    const state = stringOrNull(node.state);
    if (!name || !state) {
      diagnostics.push("GitHub returned an incomplete commit status");
      return null;
    }
    return {
      kind: "status",
      name,
      state,
      description: stringOrNull(node.description),
      targetUrl: stringOrNull(node.targetUrl),
      createdAt: stringOrNull(node.createdAt),
    };
  }
  diagnostics.push(`GitHub returned an unknown CI context type: ${String(node.__typename)}`);
  return null;
}

function parseCommit(value: unknown, expectedSha?: string): ParsedCommit | null {
  const commit = record(value);
  if (!commit) return null;
  const sha = stringOrNull(commit.oid);
  if (!sha) throw new Error("GitHub returned a commit without an oid");
  if (expectedSha && sha.toLowerCase() !== expectedSha.toLowerCase())
    throw new Error(`GitHub resolved ${expectedSha} to unexpected commit ${sha}`);
  const rollup = record(commit.statusCheckRollup);
  if (!rollup) {
    return {
      head: {
        sha,
        committedAt: stringOrNull(commit.committedDate),
        aggregateState: "NONE",
        contexts: [],
        diagnostics: [],
      },
      pageInfo: { hasNextPage: false, endCursor: null },
    };
  }
  const rawState = stringOrNull(rollup.state);
  if (!rawState || !AGGREGATE_STATES.has(rawState as CiAggregateState))
    throw new Error(`GitHub returned an unknown CI aggregate state: ${String(rollup.state)}`);
  const connection = record(rollup.contexts);
  if (!connection || !Array.isArray(connection.nodes))
    throw new Error("GitHub returned incomplete CI contexts");
  const diagnostics: string[] = [];
  const contexts = connection.nodes
    .map((node) => parseContext(node, diagnostics))
    .filter((context): context is CiContext => context !== null);
  const page = record(connection.pageInfo);
  return {
    head: {
      sha,
      committedAt: stringOrNull(commit.committedDate),
      aggregateState: rawState as CiAggregateState,
      contexts,
      diagnostics,
    },
    pageInfo: {
      hasNextPage: page?.hasNextPage === true,
      endCursor: stringOrNull(page?.endCursor),
    },
  };
}

function errorMessage(result: GitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail === "" ? `gh api exited ${result.code}` : detail;
}

function graphQlErrors(value: unknown, alias?: string): string[] {
  const root = record(value);
  if (!root || !Array.isArray(root.errors)) return [];
  return root.errors.flatMap((candidate) => {
    const error = record(candidate);
    const path = Array.isArray(error?.path) ? error.path : [];
    if (alias && path[0] !== alias) return [];
    const message = stringOrNull(error?.message);
    return message ? [message] : [];
  });
}

async function fetchRemainingContexts(
  project: GitHubProject,
  initial: ParsedCommit,
  gh: GhRunner,
): Promise<CiHead> {
  let pageInfo = initial.pageInfo;
  const contexts = [...initial.head.contexts];
  const diagnostics = [...initial.head.diagnostics];
  let pageNumber = 1;
  while (pageInfo.hasNextPage) {
    pageNumber += 1;
    if (pageNumber > MAX_CONTEXT_PAGES)
      throw new Error(`GitHub CI contexts exceed ${MAX_CONTEXT_PAGES * CONTEXT_PAGE_SIZE} entries`);
    if (!pageInfo.endCursor) throw new Error("GitHub omitted the next CI context cursor");
    const result = await gh([
      "api",
      "graphql",
      "-f",
      `query=${pageQuery(project, initial.head.sha, pageInfo.endCursor)}`,
    ]);
    if (result.code !== 0) throw new Error(errorMessage(result));
    const parsedJson = JSON.parse(result.stdout) as unknown;
    const errors = graphQlErrors(parsedJson);
    if (errors.length > 0) throw new Error(errors.join("; "));
    const next = parseCommit(
      record(record(record(parsedJson)?.data)?.repository)?.object,
      initial.head.sha,
    );
    if (!next) throw new Error("GitHub omitted a paginated CI commit");
    contexts.push(...next.head.contexts);
    diagnostics.push(...next.head.diagnostics);
    pageInfo = next.pageInfo;
  }
  return {
    ...initial.head,
    contexts: contexts.sort((left, right) =>
      `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
    ),
    diagnostics,
  };
}

async function projectInput(project: GitHubProject, git: GitRunner): Promise<ProjectInput> {
  const path = project.paths[0];
  if (!path) return { project, primaryBranch: "main", localShas: [], targets: [], diagnostics: [] };
  const configured = await git(path, ["config", "--get", "supervisor.trunk"]);
  const primaryBranch =
    configured.code === 0 && configured.stdout.trim() !== "" ? configured.stdout.trim() : "main";
  const [primaryHead, worktrees] = await Promise.all([
    git(path, ["rev-parse", `refs/heads/${primaryBranch}`]),
    git(path, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  const diagnostics: string[] = [];
  const targets: CiTarget[] = [];
  const localShas = new Set<string>();
  const primarySha = primaryHead.code === 0 ? primaryHead.stdout.trim() : "";
  if (primarySha !== "") {
    localShas.add(primarySha);
    targets.push({ kind: "branch", branch: primaryBranch, role: "primary", headSha: primarySha });
  } else {
    targets.push({ kind: "branch", branch: primaryBranch, role: "primary", headSha: null });
    diagnostics.push(`could not resolve local primary branch ${primaryBranch}`);
  }
  if (worktrees.code === 0) {
    for (const checkout of parseWorktrees(worktrees.stdout)) {
      if (!checkout.head || checkout.prunable) continue;
      localShas.add(checkout.head);
      targets.push({
        kind: "checkout",
        path: checkout.path,
        branch: checkout.detached ? null : checkout.branch,
        headSha: checkout.head,
      });
    }
  } else {
    diagnostics.push(worktrees.stderr.trim() || "could not list local worktrees for CI");
  }
  return { project, primaryBranch, localShas: [...localShas], targets, diagnostics };
}

function unavailableProjection(
  input: ProjectInput,
  revision: number,
  now: () => Date,
  diagnostic: string,
): CiProjection {
  return {
    schemaVersion: CI_PROJECTION_SCHEMA_VERSION,
    revision,
    projectedAt: now().toISOString(),
    owner: input.project.owner,
    repo: input.project.repo,
    paths: [...input.project.paths],
    available: false,
    visibility: null,
    defaultBranch: null,
    primaryBranch: input.primaryBranch,
    heads: input.localShas.map((sha) => ({
      sha,
      committedAt: null,
      aggregateState: "UNAVAILABLE",
      contexts: [],
      diagnostics: [diagnostic],
    })),
    targets: input.targets,
    diagnostics: [...input.diagnostics, diagnostic],
  };
}

export async function fetchCiProjections(
  projects: readonly GitHubProject[],
  revisions: ReadonlyMap<string, number>,
  gh: GhRunner = runGh,
  now: () => Date = () => new Date(),
  git: GitRunner = runGit,
): Promise<CiProjection[]> {
  if (projects.length === 0) return [];
  const inputs = await Promise.all(projects.map((project) => projectInput(project, git)));
  const result = await gh(["api", "graphql", "-f", `query=${batchQuery(inputs)}`]);
  if (result.code !== 0) {
    const diagnostic = `could not query GitHub CI: ${errorMessage(result)}`;
    return inputs.map((input) =>
      unavailableProjection(
        input,
        revisions.get(projectKey(input.project.owner, input.project.repo)) ?? 1,
        now,
        diagnostic,
      ),
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.stdout) as unknown;
  } catch {
    return inputs.map((input) =>
      unavailableProjection(
        input,
        revisions.get(projectKey(input.project.owner, input.project.repo)) ?? 1,
        now,
        "GitHub returned invalid JSON while querying CI",
      ),
    );
  }
  const data = record(record(parsedJson)?.data);
  return await Promise.all(
    inputs.map(async (input, projectIndex) => {
      const alias = `p${projectIndex}`;
      const revision = revisions.get(projectKey(input.project.owner, input.project.repo)) ?? 1;
      const errors = graphQlErrors(parsedJson, alias);
      const repository = record(data?.[alias]);
      if (!repository || errors.length > 0)
        return unavailableProjection(
          input,
          revision,
          now,
          `could not query GitHub CI: ${errors.join("; ") || "repository was omitted"}`,
        );
      try {
        const branch = record(repository.defaultBranchRef);
        const defaultBranch = stringOrNull(branch?.name);
        const defaultCommit = parseCommit(record(branch?.target));
        const parsedHeads: ParsedCommit[] = [];
        if (defaultCommit) parsedHeads.push(defaultCommit);
        for (let headIndex = 0; headIndex < input.localShas.length; headIndex += 1) {
          const sha = input.localShas[headIndex];
          if (!sha) continue;
          const parsed = parseCommit(repository[`h${headIndex}`], sha);
          if (parsed) parsedHeads.push(parsed);
          else if (defaultCommit?.head.sha.toLowerCase() === sha.toLowerCase()) continue;
          else
            parsedHeads.push({
              head: {
                sha,
                committedAt: null,
                aggregateState: "LOCAL",
                contexts: [],
                diagnostics: ["commit is not present on GitHub"],
              },
              pageInfo: { hasNextPage: false, endCursor: null },
            });
        }
        const hydrated = await Promise.all(
          parsedHeads.map((head) => fetchRemainingContexts(input.project, head, gh)),
        );
        const heads = new Map<string, CiHead>();
        for (const head of hydrated) heads.set(head.sha.toLowerCase(), head);
        const targets = [...input.targets];
        if (defaultBranch)
          targets.push({
            kind: "branch",
            branch: defaultBranch,
            role: "default",
            headSha: defaultCommit?.head.sha ?? null,
          });
        return {
          schemaVersion: CI_PROJECTION_SCHEMA_VERSION,
          revision,
          projectedAt: now().toISOString(),
          owner: input.project.owner,
          repo: input.project.repo,
          paths: [...input.project.paths],
          available: true,
          visibility: repositoryVisibility(repository.visibility),
          defaultBranch,
          primaryBranch: input.primaryBranch,
          heads: [...heads.values()],
          targets,
          diagnostics: input.diagnostics,
        };
      } catch (error) {
        return unavailableProjection(
          input,
          revision,
          now,
          `could not query GitHub CI: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }),
  );
}

export function projectKey(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

export function ciChannel(owner: string, repo: string): string {
  return `ci:${owner.toLowerCase()}:${repo.toLowerCase()}`;
}

export function deliveryAffectsCi(delivery: WebhookDelivery, _projection?: CiProjection): boolean {
  return ["repository", "push", "check_run", "check_suite", "status", "workflow_run"].includes(
    delivery.event,
  );
}

function channelMatches(patterns: readonly string[], channel: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? channel.startsWith(pattern.slice(0, -1)) : pattern === channel,
  );
}

class GitHubCiProjectionStore implements CiProjectionStore {
  readonly diagnostics: readonly string[];
  readonly #projects = new Map<string, GitHubProject>();
  readonly #projections = new Map<string, CiProjection>();
  readonly #listeners = new Set<ProjectionListener>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #refreshes = new Map<string, Promise<void>>();
  readonly #rerun = new Set<string>();
  readonly #gh: GhRunner;
  readonly #git: GitRunner;
  readonly #now: () => Date;
  readonly #refreshDelayMs: number;
  #hydration: Promise<void> | null = null;
  #closed = false;

  constructor(
    projects: readonly GitHubProject[],
    diagnostics: readonly string[],
    gh: GhRunner,
    git: GitRunner,
    now: () => Date,
    refreshDelayMs: number,
  ) {
    this.diagnostics = diagnostics;
    this.#gh = gh;
    this.#git = git;
    this.#now = now;
    this.#refreshDelayMs = refreshDelayMs;
    for (const project of projects)
      this.#projects.set(projectKey(project.owner, project.repo), project);
  }

  list(): readonly CiProjection[] {
    return [...this.#projections.values()].sort((left, right) =>
      ciChannel(left.owner, left.repo).localeCompare(ciChannel(right.owner, right.repo)),
    );
  }

  async snapshot(channels: readonly string[]): Promise<readonly CiProjection[]> {
    if (this.#closed) return [];
    while (!this.#closed) {
      const missing = [...this.#projects.entries()].filter(
        ([key, project]) =>
          !this.#projections.has(key) &&
          channelMatches(channels, ciChannel(project.owner, project.repo)),
      );
      if (missing.length === 0) break;
      if (this.#hydration) {
        await this.#hydration;
        continue;
      }
      const revisions = new Map(missing.map(([key]) => [key, 1]));
      const hydration = fetchCiProjections(
        missing.map(([, project]) => project),
        revisions,
        this.#gh,
        this.#now,
        this.#git,
      )
        .then((fetched) => {
          if (!this.#closed)
            for (const projection of fetched)
              if (!this.#projections.has(projectKey(projection.owner, projection.repo)))
                this.#projections.set(projectKey(projection.owner, projection.repo), projection);
        })
        .finally(() => {
          if (this.#hydration === hydration) this.#hydration = null;
        });
      this.#hydration = hydration;
      await hydration;
    }
    return this.list().filter((projection) =>
      channelMatches(channels, ciChannel(projection.owner, projection.repo)),
    );
  }

  onUpdate(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  handleDelivery(delivery: WebhookDelivery): void {
    if (this.#closed || !deliveryAffectsCi(delivery)) return;
    const key = projectKey(delivery.owner, delivery.repo);
    if (!this.#projects.has(key)) return;
    const existing = this.#timers.get(key);
    if (existing) clearTimeout(existing);
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        this.#startRefresh(key);
      }, this.#refreshDelayMs),
    );
  }

  #startRefresh(key: string): void {
    if (this.#refreshes.has(key)) {
      this.#rerun.add(key);
      return;
    }
    const project = this.#projects.get(key);
    if (!project || this.#closed) return;
    const revision = (this.#projections.get(key)?.revision ?? 0) + 1;
    const refresh = fetchCiProjections(
      [project],
      new Map([[key, revision]]),
      this.#gh,
      this.#now,
      this.#git,
    )
      .then(([projection]) => {
        if (!projection || this.#closed) return;
        this.#projections.set(key, projection);
        for (const listener of this.#listeners) listener(projection);
      })
      .finally(() => {
        if (this.#refreshes.get(key) === refresh) this.#refreshes.delete(key);
        if (this.#rerun.delete(key) && !this.#closed) this.#startRefresh(key);
      });
    this.#refreshes.set(key, refresh);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#rerun.clear();
    await Promise.allSettled([
      ...this.#refreshes.values(),
      ...(this.#hydration ? [this.#hydration] : []),
    ]);
    this.#listeners.clear();
  }
}

export async function createCiProjectionStore(
  options: CreateCiProjectionStoreOptions,
): Promise<CiProjectionStore> {
  const gh = options.gh ?? runGh;
  const git = options.git ?? runGit;
  const now = options.now ?? (() => new Date());
  let discovery: GitHubProjectDiscovery;
  try {
    discovery = await discoverGitHubProjects(options.root, git);
  } catch (error) {
    const diagnostic = `could not discover registered projects: ${error instanceof Error ? error.message : String(error)}`;
    return new GitHubCiProjectionStore([], [diagnostic], gh, git, now, DEFAULT_REFRESH_DELAY_MS);
  }
  const refreshDelayMs = options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
  if (!Number.isSafeInteger(refreshDelayMs) || refreshDelayMs < 0)
    throw new Error("invalid CI refresh delay");
  return new GitHubCiProjectionStore(
    discovery.projects,
    discovery.diagnostics,
    gh,
    git,
    now,
    refreshDelayMs,
  );
}
