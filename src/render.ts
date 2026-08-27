import { stringWidth } from "bun";
import { GLYPHS, type TokenName } from "./tui/theme.ts";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ProjectStatus,
  type ScanResult,
  type SerializedObservation,
  type WorkingStats,
  type WorktreeStatus,
} from "./types.ts";

export interface Span {
  text: string;
  token: TokenName;
  bold?: boolean;
}

export type Line = Span[];

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Keep repository-controlled text from emitting terminal or bidi controls. */
export function sanitizeText(text: string): string {
  return [...text]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      const unsafe =
        point <= 0x1f ||
        point === 0x061c ||
        (point >= 0x7f && point <= 0x9f) ||
        point === 0x200e ||
        point === 0x200f ||
        (point >= 0x2028 && point <= 0x202e) ||
        (point >= 0x2066 && point <= 0x206f) ||
        point === 0xfeff ||
        (point >= 0xfff9 && point <= 0xfffb);
      return unsafe ? "�" : character;
    })
    .join("");
}

const span = (text: string, token: TokenName = "text", bold = false): Span => ({
  text: sanitizeText(text),
  token,
  ...(bold ? { bold: true } : {}),
});

function textLength(line: readonly Span[]): number {
  return line.reduce((total, part) => total + stringWidth(part.text), 0);
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  if (width === 1) return GLYPHS.ellipsis;
  const target = width - stringWidth(GLYPHS.ellipsis);
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const cells = stringWidth(segment);
    if (used + cells > target) break;
    result += segment;
    used += cells;
  }
  return `${result}${GLYPHS.ellipsis}`;
}

export function clipLine(line: readonly Span[], width: number): Line {
  const clipped: Line = [];
  let remaining = Math.max(0, width);
  for (const part of line) {
    if (remaining === 0) break;
    const text = truncate(part.text, remaining);
    if (text !== "") clipped.push({ ...part, text });
    remaining -= stringWidth(text);
    if (stringWidth(text) < stringWidth(part.text)) break;
  }
  return clipped;
}

function aligned(left: Line, right: Line, width: number): Line {
  const rightWidth = textLength(right);
  const naturalGap = width - textLength(left) - rightWidth;
  if (naturalGap >= 2) return [...left, span(" ".repeat(naturalGap), "canvas"), ...right];
  const leftWidth = Math.max(4, width - rightWidth - 2);
  const clippedLeft = clipLine(left, leftWidth);
  const remaining = width - textLength(clippedLeft);
  if (remaining < 3) return clipLine(left, width);
  return [
    ...clippedLeft,
    span(" ".repeat(Math.max(2, remaining - rightWidth)), "canvas"),
    ...clipLine(right, Math.max(0, width - textLength(clippedLeft) - 2)),
  ];
}

function count(value: number, singular: string, compact: string): string {
  return `${value}${compact}${value === 1 ? "" : ""}${compact === "" ? ` ${singular}${value === 1 ? "" : "s"}` : ""}`;
}

function totalMetric(value: number, singular: string): Line {
  return [span(String(value)), span(` ${singular}${value === 1 ? "" : "S"}`, "muted")];
}

function renderObservationTotals(result: ScanResult, width: number): Line[] {
  const totals = result.projects.reduce(
    (sum, project) => ({
      worktrees: sum.worktrees + project.worktrees.length,
      workingFiles: sum.workingFiles + project.working.files,
      unpushedCommits: sum.unpushedCommits + project.unpushed.commits,
    }),
    { worktrees: 0, workingFiles: 0, unpushedCommits: 0 },
  );
  if (width >= 72) {
    const metrics = [
      totalMetric(result.projects.length, "PROJECT"),
      totalMetric(totals.worktrees, "LINKED WORKTREE"),
      totalMetric(totals.workingFiles, "WORKING FILE"),
      totalMetric(totals.unpushedCommits, "UNPUSHED COMMIT"),
    ];
    const line: Line = [span(GLYPHS.rail, "accent"), span(" ")];
    metrics.forEach((metric, index) => {
      if (index > 0) line.push(span(` ${GLYPHS.separator} `, "muted"));
      line.push(...metric);
    });
    return [clipLine(line, width)];
  }
  const compactRow = (
    prefix: Line,
    leftLabel: string,
    leftValue: number,
    rightLabel: string,
    rightValue: number,
  ): Line =>
    clipLine(
      [
        ...prefix,
        span(leftLabel.padEnd(10), "muted"),
        span(String(leftValue)),
        span("   ", "canvas"),
        span(rightLabel.padEnd(10), "muted"),
        span(String(rightValue)),
      ],
      width,
    );
  return [
    compactRow(
      [span(GLYPHS.rail, "accent"), span(" ")],
      "PROJECTS",
      result.projects.length,
      "WORKTREES",
      totals.worktrees,
    ),
    compactRow([span("  ")], "WORKING", totals.workingFiles, "UNPUSHED", totals.unpushedCommits),
  ];
}

function changeDetails(stats: WorkingStats, compact: boolean): string[] {
  const details: string[] = [];
  if (stats.staged > 0) details.push(compact ? `${stats.staged}stg` : `${stats.staged} staged`);
  if (stats.unstaged > 0)
    details.push(compact ? `${stats.unstaged}mod` : `${stats.unstaged} unstaged`);
  if (stats.untracked > 0)
    details.push(compact ? `${stats.untracked}new` : `${stats.untracked} untracked`);
  if (stats.conflicts > 0)
    details.push(compact ? `${stats.conflicts}conf` : count(stats.conflicts, "conflict", ""));
  if (stats.binary > 0)
    details.push(compact ? `${stats.binary}bin` : count(stats.binary, "binary", ""));
  return details;
}

function workingLine(project: ProjectStatus, width: number): Line {
  const stats = project.working;
  const compact = width < 66;
  const label = compact ? "DIFF" : "WORKING";
  const line: Line = [
    span("  "),
    span(label.padEnd(compact ? 7 : 11), stats.files > 0 ? "local" : "muted"),
  ];
  if (stats.files === 0) return [...line, span("clean", "muted")];
  const core = compact
    ? `${stats.files}f +${stats.additions} -${stats.deletions}`
    : `${count(stats.files, "file", "")} ${GLYPHS.separator} +${stats.additions} -${stats.deletions}`;
  line.push(span(core));
  const details = changeDetails(stats, compact);
  if (details.length > 0)
    line.push(span(` ${GLYPHS.separator} ${details.join(` ${GLYPHS.separator} `)}`, "muted"));
  return clipLine(line, width);
}

function unpushedLine(project: ProjectStatus, width: number): Line {
  const stats = project.unpushed;
  const compact = width < 66;
  const line: Line = [
    span("  "),
    span(
      (compact ? "UNPUSH" : "UNPUSHED").padEnd(compact ? 7 : 11),
      stats.commits > 0 ? "local" : "muted",
    ),
  ];
  if (stats.commits === 0) return [...line, span("none", "muted")];
  const value = compact
    ? `${stats.commits}c ${stats.files}f +${stats.additions} -${stats.deletions}`
    : `${count(stats.commits, "commit", "")} ${GLYPHS.separator} ${count(stats.files, "file", "")} ${GLYPHS.separator} +${stats.additions} -${stats.deletions}`;
  line.push(span(value));
  if (stats.binary > 0) line.push(span(` ${GLYPHS.separator} ${stats.binary} binary`, "muted"));
  return clipLine(line, width);
}

function worktreeState(worktree: WorktreeStatus, primary: string | null, compact: boolean): Line {
  const branch = primary ?? "primary";
  const line: Line = [span(compact ? "    " : "      ")];
  if (worktree.mergeState === "merged") {
    line.push(span("MERGED", "ok"), span(compact ? ` ${branch}` : ` INTO ${branch}`, "muted"));
  } else if (worktree.mergeState === "unmerged") {
    line.push(span("UNMERGED", "hot"), span(compact ? ` ${branch}` : ` INTO ${branch}`, "muted"));
  } else {
    line.push(
      span("UNKNOWN", "danger"),
      span(compact ? ` ${branch}` : ` AGAINST ${branch}`, "muted"),
    );
  }
  if (worktree.ahead !== null && worktree.behind !== null) {
    line.push(
      span(
        compact
          ? ` +${worktree.ahead} -${worktree.behind}`
          : ` ${GLYPHS.separator} ${worktree.ahead} ahead ${GLYPHS.separator} ${worktree.behind} behind`,
      ),
    );
  }
  if (worktree.dirtyFiles > 0) {
    line.push(
      span(
        compact
          ? ` ${GLYPHS.separator} ${worktree.dirtyFiles} dirty`
          : ` ${GLYPHS.separator} ${count(worktree.dirtyFiles, "working file", "")}`,
        "local",
      ),
    );
  }
  return line;
}

function worktreeLines(worktree: WorktreeStatus, primary: string | null, width: number): Line[] {
  const compact = width < 66;
  const name = worktree.branch ?? `detached@${worktree.head.slice(0, 8) || "unknown"}`;
  const first: Line = [span("    "), span(name, "text", true)];
  if (!compact) first.push(span(` ${GLYPHS.separator} ${worktree.displayPath}`, "muted"));
  const lines = [
    clipLine(first, width),
    clipLine(worktreeState(worktree, primary, compact), width),
  ];
  if (compact) lines.push(clipLine([span("      "), span(worktree.displayPath, "muted")], width));
  if (worktree.issue) {
    lines.push(clipLine([span("      "), span(worktree.issue, "danger")], width));
  }
  return lines;
}

export function renderProject(project: ProjectStatus, width: number): Line[] {
  const available = Math.max(1, width);
  const linked = `${project.worktrees.length} linked`;
  const primary = project.primaryBranch ?? "PRIMARY ?";
  const header = aligned(
    [span(GLYPHS.rail, "accent", true), span(` ${project.name}`, "text", true)],
    [span(`${primary} ${GLYPHS.separator} ${linked}`, project.primaryBranch ? "muted" : "danger")],
    available,
  );
  const lines: Line[] = [header];
  if (available >= 66)
    lines.push(clipLine([span("  "), span(project.displayPath, "muted")], available));
  lines.push(workingLine(project, available));
  lines.push(unpushedLine(project, available));
  for (const worktree of project.worktrees) {
    lines.push(...worktreeLines(worktree, project.primaryBranch, available));
  }
  for (const issue of project.issues) {
    lines.push(clipLine([span("  "), span(issue, "danger")], available));
  }
  return lines;
}

export function renderScan(result: ScanResult | null, width: number, scanning = false): Line[] {
  const available = Math.max(1, width);
  if (!result) {
    return [
      [
        span(scanning ? GLYPHS.refresh : GLYPHS.idle, scanning ? "accent" : "muted"),
        span(scanning ? " SCANNING ~/code" : " NO OBSERVATION", scanning ? "text" : "muted"),
      ],
    ];
  }
  const lines: Line[] = [...renderObservationTotals(result, available), []];
  if (result.projects.length === 0) {
    if (result.diagnostics.length === 0) {
      lines.push([span(`${GLYPHS.idle} CLEAR`, "ok")]);
      lines.push([
        span("No projects have working changes, unpushed work, or linked worktrees.", "muted"),
      ]);
      lines.push([span("Run refresh from the command palette to scan again.", "muted")]);
    }
  }
  result.projects.forEach((project, index) => {
    if (index > 0) lines.push([]);
    lines.push(...renderProject(project, available));
  });
  if (result.diagnostics.length > 0) {
    if (lines.length > 0) lines.push([]);
    lines.push([span(`${GLYPHS.rail} OBSERVATION WARNINGS`, "danger", true)]);
    for (const diagnostic of result.diagnostics.slice(0, 8)) {
      lines.push(clipLine([span("  "), span(diagnostic, "danger")], available));
    }
    if (result.diagnostics.length > 8) {
      lines.push([span(`  ${result.diagnostics.length - 8} more warnings`, "muted")]);
    }
  }
  return lines;
}

export function renderFailurePanel(width: number): Line {
  return clipLine([span("FAILED", "danger", true), span(" · R REFRESH", "text")], width);
}

export function plainText(lines: readonly Line[]): string {
  return lines.map((line) => line.map((part) => part.text).join("")).join("\n");
}

export function renderSnapshot(result: ScanResult, width = 100): string {
  const title = plainText([
    clipLine([span(`AGENTSOURCE ${GLYPHS.separator} ${result.root}`)], Math.max(1, width)),
  ]);
  const body = plainText(renderScan(result, width));
  return `${title}\n\n${body}\n`;
}

export function serializeObservation(result: ScanResult): SerializedObservation {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    scannedAt: result.scannedAt.toISOString(),
    root: result.root,
    projects: result.projects,
    diagnostics: result.diagnostics,
  };
}

export function renderJson(result: ScanResult): string {
  return `${JSON.stringify(serializeObservation(result))}\n`;
}
