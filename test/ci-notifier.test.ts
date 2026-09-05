import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjection,
  coalesce,
  emptyState,
  primaryVerdict,
  readState,
  renderNotification,
  startNotifyDaemon,
  writeState,
} from "../src/ci-notifier.ts";
import type { ChannelEnvelope, CiAggregateState, CiProjection } from "../src/types.ts";

const NOW = new Date("2026-09-05T12:00:00Z");

function projection(
  repo: string,
  aggregateState: CiAggregateState,
  options: { sha?: string; url?: string | null; primaryOnly?: boolean } = {},
): CiProjection {
  const sha = options.sha ?? "a".repeat(40);
  const url = options.url === undefined ? `https://github.com/possibilities/${repo}/runs/1` : null;
  return {
    schemaVersion: 3,
    revision: 1,
    projectedAt: NOW.toISOString(),
    owner: "possibilities",
    repo,
    paths: [`/home/me/code/${repo}`],
    available: true,
    visibility: "PUBLIC",
    defaultBranch: "main",
    primaryBranch: "main",
    heads: [
      {
        sha,
        committedAt: NOW.toISOString(),
        aggregateState,
        contexts:
          aggregateState === "NONE"
            ? []
            : [
                {
                  kind: "check-run",
                  name: "ci",
                  status: aggregateState === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
                  conclusion:
                    aggregateState === "SUCCESS"
                      ? "SUCCESS"
                      : aggregateState === "FAILURE"
                        ? "FAILURE"
                        : null,
                  detailsUrl: url,
                  app: "GitHub Actions",
                  startedAt: NOW.toISOString(),
                  completedAt: null,
                },
              ],
        diagnostics: [],
      },
    ],
    targets: options.primaryOnly
      ? [{ kind: "branch", branch: "main", role: "primary", headSha: sha }]
      : [
          { kind: "branch", branch: "main", role: "primary", headSha: sha },
          { kind: "branch", branch: "main", role: "default", headSha: sha },
        ],
    diagnostics: [],
  };
}

test("the primary branch head decides the verdict, and only PASS or FAIL is one", () => {
  expect(primaryVerdict(projection("zmax", "SUCCESS"))?.verdict).toBe("PASS");
  expect(primaryVerdict(projection("zmax", "FAILURE"))?.verdict).toBe("FAIL");
  expect(primaryVerdict(projection("zmax", "ERROR"))?.verdict).toBe("FAIL");
  expect(primaryVerdict(projection("zmax", "PENDING"))).toBeNull();
  expect(primaryVerdict(projection("zmax", "NONE"))).toBeNull();
  expect(primaryVerdict(projection("zmax", "LOCAL"))).toBeNull();
  expect(primaryVerdict(projection("zmax", "UNAVAILABLE"))).toBeNull();
  expect(primaryVerdict(projection("zmax", "FAILURE"))?.url).toBe(
    "https://github.com/possibilities/zmax/runs/1",
  );
});

test("an unpushed local head yields to GitHub's head of the same branch", () => {
  const pushed = "e".repeat(40);
  const local = "f".repeat(40);
  const ahead: CiProjection = {
    ...projection("funk", "SUCCESS", { sha: pushed }),
    heads: [
      ...projection("funk", "SUCCESS", { sha: pushed }).heads,
      {
        sha: local,
        committedAt: null,
        aggregateState: "LOCAL",
        contexts: [],
        diagnostics: ["commit is not present on GitHub"],
      },
    ],
    targets: [
      { kind: "branch", branch: "main", role: "primary", headSha: local },
      { kind: "checkout", path: "/home/me/code/funk", branch: "main", headSha: local },
      { kind: "branch", branch: "main", role: "default", headSha: pushed },
    ],
  };
  expect(primaryVerdict(ahead)).toEqual({
    verdict: "PASS",
    headSha: pushed,
    url: "https://github.com/possibilities/funk/runs/1",
  });
  // A trunk that is not the default branch keeps its own head first.
  const trunk: CiProjection = {
    ...ahead,
    primaryBranch: "integration",
    heads: [
      ...ahead.heads.filter((head) => head.sha !== local),
      { ...projection("funk", "FAILURE", { sha: local }).heads[0]!, sha: local },
    ],
    targets: [
      { kind: "branch", branch: "integration", role: "primary", headSha: local },
      { kind: "branch", branch: "main", role: "default", headSha: pushed },
    ],
  };
  expect(primaryVerdict(trunk)?.verdict).toBe("FAIL");
  // Nothing on GitHub at all: no verdict.
  expect(
    primaryVerdict({
      ...ahead,
      targets: [{ kind: "branch", branch: "main", role: "primary", headSha: local }],
    }),
  ).toBeNull();
});

test("transitions are PASS to FAIL, FAIL to PASS, and a first FAIL; a first PASS is silent", () => {
  const state = emptyState();
  expect(applyProjection(state, projection("zmax", "SUCCESS"), NOW)).toEqual({
    changed: true,
    transition: null,
  });
  expect(applyProjection(state, projection("zmax", "SUCCESS"), NOW).changed).toBe(false);
  expect(applyProjection(state, projection("zmax", "FAILURE"), NOW).transition).toEqual({
    repo: "possibilities/zmax",
    from: "PASS",
    to: "FAIL",
    url: "https://github.com/possibilities/zmax/runs/1",
  });
  // A new push that is still running keeps the remembered red.
  expect(
    applyProjection(state, projection("zmax", "PENDING", { sha: "b".repeat(40) }), NOW),
  ).toEqual({ changed: false, transition: null });
  expect(state.repos["possibilities/zmax"]?.verdict).toBe("FAIL");
  expect(
    applyProjection(state, projection("zmax", "SUCCESS", { sha: "b".repeat(40) }), NOW).transition,
  ).toMatchObject({ from: "FAIL", to: "PASS" });
  expect(applyProjection(state, projection("funk", "FAILURE"), NOW).transition).toMatchObject({
    from: null,
    to: "FAIL",
  });
  // A repo with no CI never enters the count.
  expect(applyProjection(state, projection("agame", "NONE"), NOW).changed).toBe(false);
  expect(Object.keys(state.repos).sort()).toEqual(["possibilities/funk", "possibilities/zmax"]);
});

test("a flip that undoes itself inside the hold is not news", () => {
  const flip = (to: "PASS" | "FAIL", from: "PASS" | "FAIL") => ({
    repo: "possibilities/zmax",
    from,
    to,
    url: null,
  });
  expect(coalesce([flip("FAIL", "PASS"), flip("PASS", "FAIL")])).toEqual([]);
  expect(coalesce([flip("FAIL", "PASS"), flip("PASS", "FAIL"), flip("FAIL", "PASS")])).toEqual([
    flip("FAIL", "PASS"),
  ]);
});

test("the banner names what flipped and lists every red, or says all are green", () => {
  const state = emptyState();
  applyProjection(state, projection("zmax", "FAILURE"), NOW);
  applyProjection(state, projection("funk", "FAILURE"), NOW);
  applyProjection(state, projection("fxnk", "SUCCESS"), NOW);
  const red = renderNotification(
    [
      { repo: "possibilities/zmax", from: "PASS", to: "FAIL", url: "https://x/zmax" },
      { repo: "possibilities/fxnk", from: "FAIL", to: "PASS", url: null },
    ],
    state,
  );
  expect(red).toEqual({
    title: "CI: zmax went red · fxnk went green",
    message: "Red: funk, zmax",
    open: "https://x/zmax",
  });
  applyProjection(state, projection("zmax", "SUCCESS", { sha: "c".repeat(40) }), NOW);
  applyProjection(state, projection("funk", "SUCCESS", { sha: "c".repeat(40) }), NOW);
  expect(
    renderNotification(
      [{ repo: "possibilities/funk", from: "FAIL", to: "PASS", url: null }],
      state,
    ),
  ).toEqual({ title: "CI: funk went green", message: "All 3 green", open: null });
  expect(renderNotification([], state)).toEqual({
    title: "CI overview",
    message: "All 3 green",
    open: null,
  });
});

test("state survives a round trip, rejects garbage, and is owner-only", () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-notifier-state-"));
  try {
    const path = join(fixture, "nested", "notifier.json");
    const state = emptyState();
    applyProjection(state, projection("zmax", "FAILURE"), NOW);
    state.seeded = true;
    writeState(path, state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readState(path)).toEqual(state);
    writeFileSync(path, '{"schemaVersion":1,"seeded":true,"repos":{"x/y":{"verdict":"MAYBE"}}}');
    expect(readState(path)).toEqual({ schemaVersion: 1, seeded: true, repos: {} });
    writeFileSync(path, "not json");
    expect(readState(path)).toEqual(emptyState());
    expect(readState(join(fixture, "absent.json"))).toEqual(emptyState());
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

interface FakeReceiver {
  socketPath: string;
  send: (projections: CiProjection[]) => void;
  close: () => Promise<void>;
}

async function startFakeReceiver(fixture: string): Promise<FakeReceiver> {
  const socketPath = join(fixture, "webhooks.sock");
  let initial: CiProjection[] = [];
  const clients = new Set<Socket>();
  const envelope = (projection: CiProjection): string =>
    `${JSON.stringify({
      schemaVersion: 1,
      channel: `ci:${projection.owner}:${projection.repo}`,
      emittedAt: NOW.toISOString(),
      data: projection,
    } satisfies ChannelEnvelope)}\n`;
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    socket.once("data", () => {
      for (const projection of initial) socket.write(envelope(projection));
    });
    socket.once("close", () => clients.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    send: (projections) => {
      initial = projections;
      for (const client of clients)
        for (const projection of projections) client.write(envelope(projection));
    },
    close: async () => {
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

test("the daemon seeds once, then posts one grouped banner per hold window", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-notifier-"));
  const receiver = await startFakeReceiver(fixture);
  const posted = join(fixture, "posted.txt");
  const notifier = join(fixture, "notifier.sh");
  writeFileSync(notifier, `#!/bin/sh\nprintf '%s\\n' "$*" >>"${posted}"\n`);
  chmodSync(notifier, 0o755);
  const stateFile = join(fixture, "state", "notifier.json");
  const lines = (): string[] => {
    try {
      return readFileSync(posted, "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const log: string[] = [];
  receiver.send([projection("zmax", "FAILURE"), projection("fxnk", "SUCCESS")]);
  const daemon = startNotifyDaemon({
    socketPath: receiver.socketPath,
    stateFile,
    holdMs: 50,
    notifierBin: notifier,
    log: (line) => log.push(line),
  });
  try {
    await waitFor(() => lines().length === 1);
    expect(lines()[0]).toBe(
      "-title CI overview -message Red: zmax -group agentsource.ci -ignoreDnD -open https://github.com/possibilities/zmax/runs/1",
    );
    expect(readState(stateFile).seeded).toBe(true);

    // Two flips inside one hold: one banner.
    receiver.send([
      projection("zmax", "SUCCESS", { sha: "b".repeat(40) }),
      projection("funk", "FAILURE", { url: null }),
    ]);
    await waitFor(() => lines().length === 2);
    expect(lines()[1]).toBe(
      "-title CI: funk went red · zmax went green -message Red: funk -group agentsource.ci -ignoreDnD",
    );

    // A replay of the same projections is not news.
    receiver.send([
      projection("zmax", "SUCCESS", { sha: "b".repeat(40) }),
      projection("funk", "FAILURE"),
    ]);
    await Bun.sleep(150);
    expect(lines().length).toBe(2);

    // A restart remembers the verdicts and stays quiet about them.
    daemon.close();
    const restarted = startNotifyDaemon({
      socketPath: receiver.socketPath,
      stateFile,
      holdMs: 50,
      notifierBin: notifier,
      log: (line) => log.push(line),
    });
    try {
      await Bun.sleep(150);
      expect(lines().length).toBe(2);
      receiver.send([projection("funk", "SUCCESS", { sha: "d".repeat(40) })]);
      await waitFor(() => lines().length === 3);
      expect(lines()[2]).toBe(
        "-title CI: funk went green -message All 3 green -group agentsource.ci -ignoreDnD",
      );
    } finally {
      restarted.close();
    }
  } finally {
    daemon.close();
    await receiver.close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
