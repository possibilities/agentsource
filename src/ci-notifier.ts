import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { subscribeChannels } from "./channel-client.ts";
import { normalizeCiState, projectionFromEnvelope } from "./ci-observation.ts";
import type { CiContext, CiProjection } from "./types.ts";

/**
 * CI transition notifier.
 *
 * Subscribes to the receiver's `ci:*` channels and remembers one verdict per
 * registered project: the normalized state of its primary-branch head, PASS or
 * FAIL. PENDING, NONE, LOCAL, and UNKNOWN never overwrite a remembered
 * verdict, so a fresh push does not read as "went green" before its run ends,
 * and a project with no CI stays outside the count.
 *
 * A change between PASS and FAIL is a transition, and so is a first FAIL for a
 * project nobody had a verdict for; a first PASS is not. Transitions are held
 * briefly and coalesced into one macOS notification whose title names what
 * flipped and whose message lists every project still red, or says all are
 * green.
 *
 * Remembered verdicts persist, so a restart or a receiver reconnect — which
 * replays every projection — notifies only what changed while the notifier
 * was away. The first start seeds silently and posts one baseline overview.
 *
 * Delivery is best-effort: a missing terminal-notifier is logged, never fatal.
 */

export const NOTIFIER_STATE_SCHEMA_VERSION = 1 as const;
export const NOTIFICATION_GROUP = "agentsource.ci";
export const DEFAULT_HOLD_MS = 90_000;
const NOTIFIER_TIMEOUT_MS = 10_000;

export type Verdict = "PASS" | "FAIL";

export interface RepoVerdict {
  verdict: Verdict;
  headSha: string;
  url: string | null;
  changedAt: string;
}

export interface NotifierState {
  schemaVersion: typeof NOTIFIER_STATE_SCHEMA_VERSION;
  seeded: boolean;
  repos: Record<string, RepoVerdict>;
}

export interface Transition {
  repo: string;
  from: Verdict | null;
  to: Verdict;
  url: string | null;
}

export interface Notification {
  title: string;
  message: string;
  open: string | null;
}

export function defaultNotifierStatePath(): string {
  return join(homedir(), ".local", "state", "agentsource", "notifier.json");
}

export function emptyState(): NotifierState {
  return { schemaVersion: NOTIFIER_STATE_SCHEMA_VERSION, seeded: false, repos: {} };
}

export function repoKey(projection: Pick<CiProjection, "owner" | "repo">): string {
  return `${projection.owner}/${projection.repo}`;
}

const GREEN_CHECK_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const GREEN_STATUS_STATES = new Set(["SUCCESS", "EXPECTED", "PENDING"]);

function contextIsRed(context: CiContext): boolean {
  if (context.kind === "check-run")
    return (
      context.conclusion !== null && !GREEN_CHECK_CONCLUSIONS.has(context.conclusion.toUpperCase())
    );
  return !GREEN_STATUS_STATES.has(context.state.toUpperCase());
}

function contextUrl(context: CiContext | undefined): string | null {
  if (!context) return null;
  return context.kind === "check-run" ? context.detailsUrl : context.targetUrl;
}

/**
 * The verdict a projection gives its primary branch, or null when it gives none.
 *
 * The primary target is the local checkout's head, which is ahead of GitHub
 * whenever work is committed and not yet pushed, and behind it whenever the
 * checkout has not fetched. CI only ever ran on what GitHub has, so when the
 * primary branch is also the default branch, GitHub's own head of it decides;
 * a configured trunk that differs from the default branch keeps its local
 * head first and falls back to the default branch only when that head is not
 * on GitHub at all.
 */
export function primaryVerdict(projection: CiProjection): Omit<RepoVerdict, "changedAt"> | null {
  const branchTargets = projection.targets.filter((target) => target.kind === "branch");
  const primary = branchTargets.find((target) => target.role === "primary");
  const fallback = branchTargets.find((target) => target.role === "default");
  const sameBranch = primary && fallback && primary.branch === fallback.branch;
  const candidates = sameBranch ? [fallback, primary] : [primary, fallback];
  for (const target of candidates) {
    const sha = target?.headSha;
    if (!sha) continue;
    const head = projection.heads.find(
      (candidate) => candidate.sha.toLowerCase() === sha.toLowerCase(),
    );
    if (!head || head.aggregateState === "LOCAL") continue;
    const state = normalizeCiState(head.aggregateState);
    if (state !== "PASS" && state !== "FAIL") return null;
    const url = contextUrl(head.contexts.find(contextIsRed)) ?? contextUrl(head.contexts[0]);
    return { verdict: state, headSha: head.sha, url };
  }
  return null;
}

export interface Applied {
  /** True when the remembered record for this project changed at all. */
  changed: boolean;
  transition: Transition | null;
}

/** Fold one projection into the remembered verdicts. Mutates `state`. */
export function applyProjection(
  state: NotifierState,
  projection: CiProjection,
  now: Date,
): Applied {
  const current = primaryVerdict(projection);
  if (!current) return { changed: false, transition: null };
  const key = repoKey(projection);
  const prior = state.repos[key];
  if (prior && prior.verdict === current.verdict) {
    const changed = prior.headSha !== current.headSha || prior.url !== current.url;
    if (changed) state.repos[key] = { ...current, changedAt: prior.changedAt };
    return { changed, transition: null };
  }
  state.repos[key] = { ...current, changedAt: now.toISOString() };
  if (!prior && current.verdict === "PASS") return { changed: true, transition: null };
  return {
    changed: true,
    transition: { repo: key, from: prior?.verdict ?? null, to: current.verdict, url: current.url },
  };
}

/** One net transition per project, dropping a flip that undid itself inside the hold. */
export function coalesce(transitions: readonly Transition[]): Transition[] {
  const byRepo = new Map<string, Transition>();
  for (const transition of transitions) {
    const first = byRepo.get(transition.repo);
    byRepo.set(
      transition.repo,
      first
        ? { repo: transition.repo, from: first.from, to: transition.to, url: transition.url }
        : transition,
    );
  }
  return [...byRepo.values()].filter((transition) => transition.from !== transition.to);
}

function shortName(key: string): string {
  return key.slice(key.indexOf("/") + 1);
}

function names(keys: readonly string[]): string {
  return keys.map(shortName).join(", ");
}

export function renderNotification(
  transitions: readonly Transition[],
  state: NotifierState,
): Notification {
  const red = Object.entries(state.repos)
    .filter(([, record]) => record.verdict === "FAIL")
    .map(([key]) => key)
    .sort();
  const total = Object.keys(state.repos).length;
  const wentRed = transitions.filter((transition) => transition.to === "FAIL");
  const wentGreen = transitions.filter((transition) => transition.to === "PASS");
  const parts: string[] = [];
  if (wentRed.length > 0) parts.push(`${names(wentRed.map((t) => t.repo))} went red`);
  if (wentGreen.length > 0) parts.push(`${names(wentGreen.map((t) => t.repo))} went green`);
  const title = parts.length > 0 ? `CI: ${parts.join(" · ")}` : "CI overview";
  const message = red.length > 0 ? `Red: ${names(red)}` : `All ${total} green`;
  const firstRed = red[0];
  const open = wentRed[0]?.url ?? (firstRed ? (state.repos[firstRed]?.url ?? null) : null);
  return { title, message, open };
}

function isVerdict(value: unknown): value is Verdict {
  return value === "PASS" || value === "FAIL";
}

export function readState(path: string): NotifierState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyState();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyState();
  if (Reflect.get(parsed, "schemaVersion") !== NOTIFIER_STATE_SCHEMA_VERSION) return emptyState();
  const rawRepos = Reflect.get(parsed, "repos");
  const state = emptyState();
  state.seeded = Reflect.get(parsed, "seeded") === true;
  if (typeof rawRepos !== "object" || rawRepos === null) return state;
  for (const [key, value] of Object.entries(rawRepos as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const verdict = Reflect.get(value, "verdict");
    const headSha = Reflect.get(value, "headSha");
    const url = Reflect.get(value, "url");
    const changedAt = Reflect.get(value, "changedAt");
    if (!isVerdict(verdict) || typeof headSha !== "string") continue;
    state.repos[key] = {
      verdict,
      headSha,
      url: typeof url === "string" ? url : null,
      changedAt: typeof changedAt === "string" ? changedAt : "",
    };
  }
  return state;
}

/** Owner-only, written whole then renamed so a reader never sees a torn file. */
export function writeState(path: string, state: NotifierState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

export function findNotifier(explicit?: string): string | null {
  return explicit ?? Bun.which("terminal-notifier");
}

const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * macOS refuses to surface a notification from an application bundle it has
 * not registered, and a Homebrew upgrade relocates the bundle; terminal-notifier
 * still exits 0, so the failure is silent. Re-register the Homebrew bundle
 * before each post. Only the Homebrew layout is known; an explicit notifier
 * elsewhere is left alone.
 */
function reregisterNotifier(notifier: string): void {
  const prefix = dirname(dirname(notifier));
  const app = join(prefix, "opt", "terminal-notifier", "terminal-notifier.app");
  if (!existsSync(app) || !existsSync(LSREGISTER)) return;
  try {
    spawnSync(LSREGISTER, ["-f", app], { stdio: "ignore", timeout: NOTIFIER_TIMEOUT_MS });
  } catch {
    // Registration is a courtesy to delivery, never a reason not to post.
  }
}

/**
 * Post through terminal-notifier. One fixed group, so a new banner replaces
 * the previous one instead of stacking; -ignoreDnD because a CI flip is worth
 * surfacing; -open carries the failing run when there is one.
 */
export function postNotification(notification: Notification, notifier: string): boolean {
  reregisterNotifier(notifier);
  const args = [
    "-title",
    notification.title,
    "-message",
    notification.message,
    "-group",
    NOTIFICATION_GROUP,
    "-ignoreDnD",
  ];
  if (notification.open) args.push("-open", notification.open);
  try {
    const result = spawnSync(notifier, args, { stdio: "ignore", timeout: NOTIFIER_TIMEOUT_MS });
    return result.status === 0;
  } catch {
    return false;
  }
}

export interface NotifyDaemonOptions {
  socketPath: string;
  stateFile: string;
  holdMs: number;
  notifierBin?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface NotifyDaemonHandle {
  close: () => void;
}

export function startNotifyDaemon(options: NotifyDaemonOptions): NotifyDaemonHandle {
  const now = options.now ?? (() => new Date());
  const log =
    options.log ?? ((line: string) => process.stderr.write(`agentsource: notifier: ${line}\n`));
  const notifier = findNotifier(options.notifierBin);
  if (!notifier) log("terminal-notifier is not installed; transitions will only be logged");
  const state = readState(options.stateFile);
  log(`remembering ${Object.keys(state.repos).length} verdicts from ${options.stateFile}`);

  let pending: Transition[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let available: boolean | null = null;

  const deliver = (notification: Notification): void => {
    log(`${notification.title} — ${notification.message}`);
    if (!notifier) return;
    if (!postNotification(notification, notifier)) log("terminal-notifier failed; not delivered");
  };
  const flush = (): void => {
    timer = undefined;
    const transitions = coalesce(pending);
    pending = [];
    if (!state.seeded) {
      state.seeded = true;
      writeState(options.stateFile, state);
      log(`seeded ${Object.keys(state.repos).length} verdicts`);
      deliver(renderNotification([], state));
      return;
    }
    if (transitions.length === 0) return;
    deliver(renderNotification(transitions, state));
  };
  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(flush, options.holdMs);
  };

  const subscription = subscribeChannels({
    channels: ["ci:*"],
    socketPath: options.socketPath,
    onValue: (value) => {
      const projection = projectionFromEnvelope(value);
      if (!projection) return;
      const applied = applyProjection(state, projection, now());
      if (applied.changed) writeState(options.stateFile, state);
      if (applied.transition) pending.push(applied.transition);
      if (!state.seeded || applied.transition) schedule();
    },
    onAvailability: (isAvailable, diagnostic) => {
      if (available === isAvailable) return;
      available = isAvailable;
      log(
        isAvailable
          ? `subscribed to ci:* at ${options.socketPath}`
          : (diagnostic ?? "receiver unavailable; retrying"),
      );
    },
  });

  return {
    close: () => {
      subscription.close();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
