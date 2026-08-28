import type { GitResult, GitRunner } from "./git.ts";
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
  type CiProjection,
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

interface ParsedRepository {
  defaultBranch: string | null;
  headSha: string | null;
  headCommittedAt: string | null;
  aggregateState: CiAggregateState;
  contexts: CiContext[];
  pageInfo: PageInfo;
  diagnostics: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contextFields(after?: string): string {
  const afterArgument = after === undefined ? "" : `, after: ${JSON.stringify(after)}`;
  return `
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          committedDate
          statusCheckRollup {
            state
            contexts(first: ${CONTEXT_PAGE_SIZE}${afterArgument}) {
              nodes {
                __typename
                ... on CheckRun {
                  name
                  status
                  conclusion
                  detailsUrl
                  startedAt
                  completedAt
                  checkSuite { app { name } }
                }
                ... on StatusContext {
                  context
                  state
                  description
                  targetUrl
                  createdAt
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
    }`;
}

function batchQuery(projects: readonly GitHubProject[]): string {
  const repositories = projects.map(
    (project, index) =>
      `p${index}: repository(owner: ${JSON.stringify(project.owner)}, name: ${JSON.stringify(project.repo)}) {${contextFields()}\n  }`,
  );
  return `query AgentsourceCi {\n  ${repositories.join("\n  ")}\n}`;
}

function pageQuery(project: GitHubProject, after: string): string {
  return `query AgentsourceCiPage {\n  repository(owner: ${JSON.stringify(project.owner)}, name: ${JSON.stringify(project.repo)}) {${contextFields(after)}\n  }\n}`;
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

function parseRepository(value: unknown): ParsedRepository {
  const repository = record(value);
  if (!repository) throw new Error("GitHub did not return the repository");
  const branch = record(repository.defaultBranchRef);
  if (!branch) {
    return {
      defaultBranch: null,
      headSha: null,
      headCommittedAt: null,
      aggregateState: "NONE",
      contexts: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      diagnostics: ["GitHub repository has no default branch"],
    };
  }
  const defaultBranch = stringOrNull(branch.name);
  const target = record(branch.target);
  const headSha = stringOrNull(target?.oid);
  if (!defaultBranch || !target || !headSha)
    throw new Error("GitHub returned an incomplete default-branch head");
  const rollup = record(target.statusCheckRollup);
  if (!rollup) {
    return {
      defaultBranch,
      headSha,
      headCommittedAt: stringOrNull(target.committedDate),
      aggregateState: "NONE",
      contexts: [],
      pageInfo: { hasNextPage: false, endCursor: null },
      diagnostics: [],
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
    defaultBranch,
    headSha,
    headCommittedAt: stringOrNull(target.committedDate),
    aggregateState: rawState as CiAggregateState,
    contexts,
    pageInfo: {
      hasNextPage: page?.hasNextPage === true,
      endCursor: stringOrNull(page?.endCursor),
    },
    diagnostics,
  };
}

function errorMessage(result: GitResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail === "" ? `gh api exited ${result.code}` : detail;
}

function unavailableProjection(
  project: GitHubProject,
  revision: number,
  now: () => Date,
  diagnostic: string,
): CiProjection {
  return {
    schemaVersion: CI_PROJECTION_SCHEMA_VERSION,
    revision,
    projectedAt: now().toISOString(),
    owner: project.owner,
    repo: project.repo,
    paths: [...project.paths],
    available: false,
    defaultBranch: null,
    headSha: null,
    headCommittedAt: null,
    aggregateState: "UNAVAILABLE",
    contexts: [],
    diagnostics: [diagnostic],
  };
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
  initial: ParsedRepository,
  gh: GhRunner,
): Promise<ParsedRepository> {
  let pageInfo = initial.pageInfo;
  const contexts = [...initial.contexts];
  const diagnostics = [...initial.diagnostics];
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
      `query=${pageQuery(project, pageInfo.endCursor)}`,
    ]);
    if (result.code !== 0) throw new Error(errorMessage(result));
    const parsedJson = JSON.parse(result.stdout) as unknown;
    const errors = graphQlErrors(parsedJson);
    if (errors.length > 0) throw new Error(errors.join("; "));
    const next = parseRepository(record(record(parsedJson)?.data)?.repository);
    if (next.headSha !== initial.headSha)
      throw new Error("default-branch HEAD changed while reading CI contexts");
    contexts.push(...next.contexts);
    diagnostics.push(...next.diagnostics);
    pageInfo = next.pageInfo;
  }
  return { ...initial, contexts, diagnostics, pageInfo };
}

export async function fetchCiProjections(
  projects: readonly GitHubProject[],
  revisions: ReadonlyMap<string, number>,
  gh: GhRunner = runGh,
  now: () => Date = () => new Date(),
): Promise<CiProjection[]> {
  if (projects.length === 0) return [];
  const result = await gh(["api", "graphql", "-f", `query=${batchQuery(projects)}`]);
  if (result.code !== 0) {
    const diagnostic = `could not query GitHub CI: ${errorMessage(result)}`;
    return projects.map((project) =>
      unavailableProjection(
        project,
        revisions.get(projectKey(project.owner, project.repo)) ?? 1,
        now,
        diagnostic,
      ),
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(result.stdout) as unknown;
  } catch {
    return projects.map((project) =>
      unavailableProjection(
        project,
        revisions.get(projectKey(project.owner, project.repo)) ?? 1,
        now,
        "GitHub returned invalid JSON while querying CI",
      ),
    );
  }
  const data = record(record(parsedJson)?.data);
  return await Promise.all(
    projects.map(async (project, index) => {
      const alias = `p${index}`;
      const revision = revisions.get(projectKey(project.owner, project.repo)) ?? 1;
      const errors = graphQlErrors(parsedJson, alias);
      if (errors.length > 0)
        return unavailableProjection(
          project,
          revision,
          now,
          `could not query GitHub CI: ${errors.join("; ")}`,
        );
      try {
        const parsed = await fetchRemainingContexts(project, parseRepository(data?.[alias]), gh);
        return {
          schemaVersion: CI_PROJECTION_SCHEMA_VERSION,
          revision,
          projectedAt: now().toISOString(),
          owner: project.owner,
          repo: project.repo,
          paths: [...project.paths],
          available: true,
          defaultBranch: parsed.defaultBranch,
          headSha: parsed.headSha,
          headCommittedAt: parsed.headCommittedAt,
          aggregateState: parsed.aggregateState,
          contexts: parsed.contexts.sort((left, right) =>
            `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`),
          ),
          diagnostics: parsed.diagnostics,
        };
      } catch (error) {
        return unavailableProjection(
          project,
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

export function deliveryAffectsCi(delivery: WebhookDelivery, projection: CiProjection): boolean {
  if (delivery.event === "repository") return true;
  if (delivery.event === "push") {
    const ref = stringOrNull(record(delivery.payload)?.ref);
    return !ref || !projection.defaultBranch || ref === `refs/heads/${projection.defaultBranch}`;
  }
  const shaByEvent: Record<string, string | null> = {
    check_run: stringOrNull(record(record(delivery.payload)?.check_run)?.head_sha),
    check_suite: stringOrNull(record(record(delivery.payload)?.check_suite)?.head_sha),
    status: stringOrNull(record(delivery.payload)?.sha),
    workflow_run: stringOrNull(record(record(delivery.payload)?.workflow_run)?.head_sha),
  };
  if (!(delivery.event in shaByEvent)) return false;
  const sha = shaByEvent[delivery.event];
  return !sha || !projection.headSha || sha === projection.headSha;
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
  readonly #now: () => Date;
  readonly #refreshDelayMs: number;
  #closed = false;

  constructor(
    projects: readonly GitHubProject[],
    projections: readonly CiProjection[],
    diagnostics: readonly string[],
    gh: GhRunner,
    now: () => Date,
    refreshDelayMs: number,
  ) {
    this.diagnostics = diagnostics;
    this.#gh = gh;
    this.#now = now;
    this.#refreshDelayMs = refreshDelayMs;
    for (const project of projects)
      this.#projects.set(projectKey(project.owner, project.repo), project);
    for (const projection of projections)
      this.#projections.set(projectKey(projection.owner, projection.repo), projection);
  }

  list(): readonly CiProjection[] {
    return [...this.#projections.values()].sort((left, right) =>
      ciChannel(left.owner, left.repo).localeCompare(ciChannel(right.owner, right.repo)),
    );
  }

  onUpdate(listener: ProjectionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  handleDelivery(delivery: WebhookDelivery): void {
    if (this.#closed) return;
    const key = projectKey(delivery.owner, delivery.repo);
    const projection = this.#projections.get(key);
    if (!projection || !deliveryAffectsCi(delivery, projection)) return;
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
    const previous = this.#projections.get(key);
    if (!project || !previous || this.#closed) return;
    const refresh = fetchCiProjections(
      [project],
      new Map([[key, previous.revision + 1]]),
      this.#gh,
      this.#now,
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
    await Promise.allSettled(this.#refreshes.values());
    this.#listeners.clear();
  }
}

export async function createCiProjectionStore(
  options: CreateCiProjectionStoreOptions,
): Promise<CiProjectionStore> {
  const gh = options.gh ?? runGh;
  const now = options.now ?? (() => new Date());
  let discovery: GitHubProjectDiscovery;
  try {
    discovery = await discoverGitHubProjects(options.root, options.git);
  } catch (error) {
    const diagnostic = `could not discover registered projects: ${error instanceof Error ? error.message : String(error)}`;
    return new GitHubCiProjectionStore([], [], [diagnostic], gh, now, DEFAULT_REFRESH_DELAY_MS);
  }
  const revisions = new Map(
    discovery.projects.map((project) => [projectKey(project.owner, project.repo), 1]),
  );
  const projections = await fetchCiProjections(discovery.projects, revisions, gh, now);
  const refreshDelayMs = options.refreshDelayMs ?? DEFAULT_REFRESH_DELAY_MS;
  if (!Number.isSafeInteger(refreshDelayMs) || refreshDelayMs < 0)
    throw new Error("invalid CI refresh delay");
  return new GitHubCiProjectionStore(
    discovery.projects,
    projections,
    discovery.diagnostics,
    gh,
    now,
    refreshDelayMs,
  );
}
