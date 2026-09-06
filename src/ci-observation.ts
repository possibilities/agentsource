import { resolve } from "node:path";
import { projectIsVisible } from "./git.ts";
import { ciChannel } from "./github-ci.ts";
import type {
  CiAggregateState,
  CiProjection,
  CiState,
  CiSummary,
  EventFrame,
  ScanResult,
} from "./types.ts";

export function normalizeCiState(state: CiAggregateState): CiState {
  switch (state) {
    case "SUCCESS":
      return "PASS";
    case "PENDING":
    case "EXPECTED":
      return "PENDING";
    case "FAILURE":
    case "ERROR":
      return "FAIL";
    case "NONE":
      return "NONE";
    case "LOCAL":
      return "LOCAL";
    case "UNAVAILABLE":
      return "UNKNOWN";
  }
}

export function projectionFromEnvelope(envelope: EventFrame): CiProjection | null {
  if (!("projection" in envelope.data)) return null;
  return envelope.data.projection;
}

function summary(projection: CiProjection | undefined, sha: string | null): CiSummary {
  const channel = projection ? ciChannel(projection.owner, projection.repo) : "ci:unavailable";
  if (!projection || !sha) return { channel, state: "UNKNOWN", headSha: sha, aggregateState: null };
  const head = projection.heads.find(
    (candidate) => candidate.sha.toLowerCase() === sha.toLowerCase(),
  );
  if (!head) return { channel, state: "UNKNOWN", headSha: sha, aggregateState: null };
  return {
    channel,
    state: normalizeCiState(head.aggregateState),
    headSha: head.sha,
    aggregateState: head.aggregateState,
  };
}

function projectionForPath(
  projections: readonly CiProjection[],
  path: string,
): CiProjection | undefined {
  const normalized = resolve(path);
  return projections.find((projection) =>
    projection.paths.some((candidate) => resolve(candidate) === normalized),
  );
}

/** Join daemon-owned CI state into a raw Git/Herdr scan, then apply visibility heuristics. */
export function applyCiObservation(
  raw: ScanResult,
  observation: {
    available: boolean;
    projections: readonly CiProjection[];
    diagnostics: readonly string[];
  },
  options: { includeQuiet?: boolean } = {},
): ScanResult {
  const projections = observation.available ? observation.projections : [];
  const projects = raw.projects.map((project) => {
    const projection = projectionForPath(projections, project.path);
    return {
      ...project,
      githubVisibility: projection?.visibility ?? null,
      primaryCi: summary(projection, project.primaryHead),
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        ci: summary(projection, worktree.head || null),
      })),
    };
  });
  return {
    ...raw,
    projects: projects.filter(
      (project) => options.includeQuiet === true || projectIsVisible(project),
    ),
    ci: {
      available: observation.available,
      projections: [...projections],
      diagnostics: [...observation.diagnostics],
    },
  };
}
