import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotChannels } from "../src/channel-client.ts";
import type { CiProjectionStore } from "../src/github-ci.ts";
import {
  CI_PROJECTION_SCHEMA_VERSION,
  type CiProjection,
  type WebhookDelivery,
} from "../src/types.ts";
import {
  ensureWebhookSecret,
  type RunningWebhookDaemon,
  readWebhookSecret,
  startWebhookDaemon,
} from "../src/webhooks.ts";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef");
const fixtures: string[] = [];
const daemons: RunningWebhookDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

async function start(
  options: { maxBodyBytes?: number; ciStore?: CiProjectionStore } = {},
): Promise<RunningWebhookDaemon> {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-webhooks-"));
  fixtures.push(fixture);
  const daemon = await startWebhookDaemon({
    secret: SECRET,
    socketPath: join(fixture, "webhooks.sock"),
    port: 0,
    root: fixture,
    now: () => new Date("2026-08-27T20:00:00.000Z"),
    ...options,
  });
  daemons.push(daemon);
  return daemon;
}

async function subscribe(socket: Socket, patterns: string[]): Promise<void> {
  const response = nextRecord(socket);
  socket.write(
    `${JSON.stringify({ v: 1, type: "request", id: "sub", method: "event.subscribe", params: { events: patterns } })}\n`,
  );
  expect(await response).toMatchObject({ v: 1, type: "response", id: "sub", ok: true });
}

async function connect(path: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

interface SocketReader {
  buffered: string;
  records: Record<string, unknown>[];
  waiting: Array<{
    resolve: (record: Record<string, unknown>) => void;
    reject: (error: unknown) => void;
  }>;
}

const socketReaders = new WeakMap<Socket, SocketReader>();

function readerFor(socket: Socket): SocketReader {
  const existing = socketReaders.get(socket);
  if (existing) return existing;
  const reader: SocketReader = { buffered: "", records: [], waiting: [] };
  socketReaders.set(socket, reader);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    reader.buffered += chunk;
    let newline = reader.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = reader.buffered.slice(0, newline);
      reader.buffered = reader.buffered.slice(newline + 1);
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const waiting = reader.waiting.shift();
        if (waiting) waiting.resolve(parsed);
        else reader.records.push(parsed);
      } catch (error) {
        const waiting = reader.waiting.shift();
        if (waiting) waiting.reject(error);
      }
      newline = reader.buffered.indexOf("\n");
    }
  });
  socket.once("error", (error) => {
    for (const waiting of reader.waiting.splice(0)) waiting.reject(error);
  });
  return reader;
}

function nextRecord(socket: Socket): Promise<Record<string, unknown>> {
  const reader = readerFor(socket);
  const record = reader.records.shift();
  if (record) return Promise.resolve(record);
  return new Promise((resolve, reject) => reader.waiting.push({ resolve, reject }));
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function projection(owner: string, repo: string, revision = 1): CiProjection {
  return {
    schemaVersion: CI_PROJECTION_SCHEMA_VERSION,
    revision,
    projectedAt: "2026-08-27T19:59:00.000Z",
    owner,
    repo,
    paths: [`/code/${repo}`],
    available: true,
    visibility: "PUBLIC",
    defaultBranch: "main",
    primaryBranch: "main",
    heads: [
      {
        sha: "abc123",
        committedAt: "2026-08-27T19:58:00.000Z",
        aggregateState: "PENDING",
        contexts: [],
        diagnostics: [],
      },
    ],
    targets: [{ kind: "branch", branch: "main", role: "primary", headSha: "abc123" }],
    diagnostics: [],
  };
}

class FakeCiStore implements CiProjectionStore {
  readonly diagnostics: readonly string[] = [];
  readonly #listeners = new Set<(value: CiProjection) => void>();
  readonly #projections: CiProjection[];

  constructor(projections: CiProjection[]) {
    this.#projections = projections;
  }

  list(): readonly CiProjection[] {
    return this.#projections;
  }

  async snapshot(channels: readonly string[]): Promise<readonly CiProjection[]> {
    return this.#projections.filter((value) =>
      channels.some((pattern) =>
        pattern.endsWith("*")
          ? `ci:${value.owner}:${value.repo}`.startsWith(pattern.slice(0, -1))
          : pattern === `ci:${value.owner}:${value.repo}`,
      ),
    );
  }

  onUpdate(listener: (value: CiProjection) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  handleDelivery(delivery: WebhookDelivery): void {
    const index = this.#projections.findIndex(
      (value) =>
        value.owner.toLowerCase() === delivery.owner.toLowerCase() &&
        value.repo.toLowerCase() === delivery.repo.toLowerCase(),
    );
    const current = this.#projections[index];
    if (index < 0 || !current || delivery.event !== "status") return;
    const updated = {
      ...current,
      revision: current.revision + 1,
      heads: current.heads.map((head) => ({ ...head, aggregateState: "SUCCESS" as const })),
    };
    this.#projections[index] = updated;
    for (const listener of this.#listeners) listener(updated);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }
}

async function deliver(
  daemon: RunningWebhookDaemon,
  body: string,
  overrides: Record<string, string> = {},
  path = "/possibilities/agentsource",
): Promise<Response> {
  return await fetch(`http://${daemon.host}:${daemon.port}${path}`, {
    method: "POST",
    headers: {
      connection: "close",
      "content-type": "application/json",
      "x-github-delivery": "delivery-123",
      "x-github-event": "push",
      "x-github-hook-id": "42",
      "x-hub-signature-256": signature(body),
      ...overrides,
    },
    body,
  });
}

describe("webhook daemon", () => {
  test("broadcasts one authenticated delivery as schema-versioned NDJSON", async () => {
    const daemon = await start();
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["deliveries"]);
    const recordPromise = nextRecord(socket);
    const body = `{
  "repository": { "full_name": "possibilities/agentsource" },
  "ref": "refs/heads/main"
}`;
    const payload = JSON.parse(body);
    const response = await deliver(daemon, body);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, deliveryId: "delivery-123" });
    expect(await recordPromise).toEqual({
      v: 1,
      type: "event",
      event: "deliveries",
      data: {
        instanceId: expect.any(String),
        generation: 1,
        sequence: 1,
        emittedAt: "2026-08-27T20:00:00.000Z",
        delivery: {
          schemaVersion: 1,
          receivedAt: "2026-08-27T20:00:00.000Z",
          owner: "possibilities",
          repo: "agentsource",
          event: "push",
          deliveryId: "delivery-123",
          hookId: "42",
          payload,
        },
      },
    });
    expect(statSync(daemon.socketPath).mode & 0o777).toBe(0o600);
    socket.destroy();
  });

  test("flushes one large delivery before treating a client as lagging", async () => {
    const daemon = await start();
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["deliveries"]);
    const recordPromise = nextRecord(socket);
    const payload = {
      repository: { full_name: "possibilities/agentsource" },
      data: "x".repeat(64 * 1024),
    };
    expect((await deliver(daemon, JSON.stringify(payload))).status).toBe(202);
    expect(
      ((await recordPromise).data as { delivery: { payload: typeof payload } }).delivery.payload
        .data,
    ).toHaveLength(64 * 1024);
    socket.destroy();
  });

  test("rejects invalid signatures and project mismatches without broadcasting them", async () => {
    const daemon = await start();
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["deliveries"]);
    const recordPromise = nextRecord(socket);
    const body = JSON.stringify({ repository: { full_name: "possibilities/agentsource" } });

    const unsigned = await deliver(daemon, body, { "x-hub-signature-256": "sha256=00" });
    expect(unsigned.status).toBe(401);
    const mismatched = await deliver(daemon, body, {}, "/possibilities/something-else");
    expect(mismatched.status).toBe(422);
    const accepted = await deliver(daemon, body, { "x-github-delivery": "delivery-good" });
    expect(accepted.status).toBe(202);
    expect(((await recordPromise).data as { delivery: WebhookDelivery }).delivery.deliveryId).toBe(
      "delivery-good",
    );
    socket.destroy();
  });

  test("subscriptions acknowledge without replay; snapshots ignore filters and keep the connection open", async () => {
    const daemon = await start({
      ciStore: new FakeCiStore([
        projection("possibilities", "agentsource"),
        projection("possibilities", "agentstart"),
      ]),
    });
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["ci:possibilities:agentsource"]);
    for (const id of ["first", "second"]) {
      const response = nextRecord(socket);
      socket.write(
        `${JSON.stringify({ v: 1, type: "request", id, method: "state.get", params: {} })}\n`,
      );
      expect(await response).toMatchObject({
        id,
        ok: true,
        result: {
          sequence: 0,
          inventory: "complete",
          projections: [{ repo: "agentsource" }, { repo: "agentstart" }],
        },
      });
    }
    socket.destroy();
  });

  test("filters the full snapshot locally for one-shot consumers", async () => {
    const ciStore = new FakeCiStore([
      projection("possibilities", "agentsource"),
      projection("possibilities", "agentstart"),
    ]);
    const daemon = await start({ ciStore });
    const result = await snapshotChannels({
      socketPath: daemon.socketPath,
      channels: ["ci:possibilities:agentsource"],
      requestId: "observation-1",
    });
    expect(result).toMatchObject({
      available: true,
      diagnostics: [],
      values: [
        {
          event: "ci:possibilities:agentsource",
          data: { projection: { owner: "possibilities", repo: "agentsource", revision: 1 } },
        },
      ],
    });
  });

  test("emits only the changed repository projection after a relevant delivery", async () => {
    const ciStore = new FakeCiStore([
      projection("possibilities", "agentsource"),
      projection("possibilities", "agentstart"),
    ]);
    const daemon = await start({ ciStore });
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["deliveries", "ci:possibilities:agentsource"]);

    const deliveryRecord = nextRecord(socket);
    const projectionRecord = nextRecord(socket);
    const body = JSON.stringify({
      repository: { full_name: "possibilities/agentsource" },
      sha: "abc123",
    });
    expect((await deliver(daemon, body, { "x-github-event": "status" })).status).toBe(202);
    expect(await deliveryRecord).toMatchObject({ event: "deliveries" });
    expect(await projectionRecord).toMatchObject({
      event: "ci:possibilities:agentsource",
      data: { projection: { revision: 2, heads: [{ aggregateState: "SUCCESS" }] } },
    });
    socket.destroy();
  });

  test("closes malformed JSON clients; validates params without losing a subscription", async () => {
    const daemon = await start();
    const malformed = await connect(daemon.socketPath);
    const closed = new Promise<void>((resolve) => malformed.once("close", () => resolve()));
    malformed.write("not-json\n");
    await closed;
    const socket = await connect(daemon.socketPath);
    await subscribe(socket, ["deliveries"]);
    for (const events of [[], ["Bad"], ["ci:*:bad"], Array(33).fill("*")]) {
      const response = nextRecord(socket);
      socket.write(
        `${JSON.stringify({ v: 1, type: "request", id: "bad", method: "event.subscribe", params: { events } })}\n`,
      );
      expect(await response).toMatchObject({
        id: "bad",
        ok: false,
        error: { code: "invalid_params" },
      });
    }
    const record = nextRecord(socket);
    await deliver(
      daemon,
      JSON.stringify({ repository: { full_name: "possibilities/agentsource" } }),
    );
    expect(await record).toMatchObject({ event: "deliveries" });
    await subscribe(socket, ["unknown.well-formed/*"]);
    socket.destroy();
  });

  test("rejects oversized bodies and non-JSON webhook requests", async () => {
    const daemon = await start({ maxBodyBytes: 20 });
    const oversizedBody = JSON.stringify({ repository: { full_name: "a/b" } });
    expect((await deliver(daemon, oversizedBody, {}, "/a/b")).status).toBe(413);

    const body = JSON.stringify({ repository: { full_name: "a/b" } });
    expect(
      (await deliver(daemon, body, { "content-type": "application/x-www-form-urlencoded" }, "/a/b"))
        .status,
    ).toBe(415);
  });

  test("rejects bodies when the aggregate pre-authentication memory budget is exhausted", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "agentsource-webhook-budget-"));
    fixtures.push(fixture);
    const daemon = await startWebhookDaemon({
      secret: SECRET,
      socketPath: join(fixture, "webhooks.sock"),
      port: 0,
      root: fixture,
      maxBodyBytes: 1024,
      maxInFlightBodyBytes: 20,
    });
    daemons.push(daemon);
    const body = JSON.stringify({ repository: { full_name: "a/b" } });
    expect((await deliver(daemon, body, {}, "/a/b")).status).toBe(503);
  });

  test("refuses to replace an active delivery stream socket", async () => {
    const daemon = await start();
    await expect(
      startWebhookDaemon({ secret: SECRET, socketPath: daemon.socketPath, port: 0 }),
    ).rejects.toThrow("already listening");
    expect(statSync(daemon.socketPath).isSocket()).toBe(true);
  });
});

test("secret files must be private, owned regular files", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-secret-"));
  fixtures.push(fixture);
  const path = join(fixture, "secret");
  writeFileSync(path, `${SECRET.toString("utf8")}\n`, { mode: 0o644 });
  await expect(readWebhookSecret(path)).rejects.toThrow("must not be accessible");
  chmodSync(path, 0o600);
  expect(await readWebhookSecret(path)).toEqual(SECRET);

  const link = join(fixture, "secret-link");
  symlinkSync(path, link);
  await expect(readWebhookSecret(link)).rejects.toThrow("could not securely open");
});

test("secret creation is private and idempotent", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-secret-create-"));
  fixtures.push(fixture);
  const path = join(fixture, "secret");

  expect(await ensureWebhookSecret(path)).toBe("created");
  const original = await readWebhookSecret(path);
  expect(original).toHaveLength(64);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  expect(await ensureWebhookSecret(path)).toBe("existing");
  expect(await readWebhookSecret(path)).toEqual(original);
  expect(readdirSync(fixture)).toEqual(["secret"]);
});

test("secret creation never replaces an invalid existing final path", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-secret-invalid-"));
  fixtures.push(fixture);
  const path = join(fixture, "secret");
  writeFileSync(path, "too-short\n", { mode: 0o600 });

  await expect(ensureWebhookSecret(path)).rejects.toThrow("at least 32 bytes");
  expect(readdirSync(fixture)).toEqual(["secret"]);
});
