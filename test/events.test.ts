import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { snapshotChannels, subscribeChannels } from "../src/channel-client.ts";
import { discoverEventSocket, ownedPrivate } from "../src/event-discovery.ts";
import { EventFeed } from "../src/event-feed.ts";
import { JsonLines } from "../src/event-framing.ts";
import {
  type EventFrame,
  eventCatalog,
  eventSchema,
  MAX_FRAME_BYTES,
  MAX_PROJECTIONS,
  MAX_REQUEST_BYTES,
  requestsSchema,
  socketFrameSchema,
  subscriptionMatches,
} from "../src/event-schema.ts";
import type { CiProjectionStore } from "../src/github-ci.ts";
import type { CiProjection, WebhookDelivery } from "../src/types.ts";
import { startWebhookDaemon } from "../src/webhooks.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "as-events-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function projection(revision = 1, repo = "repo"): CiProjection {
  return {
    schemaVersion: 3,
    revision,
    projectedAt: "2026-09-05T00:00:00Z",
    owner: "owner",
    repo,
    paths: ["/test"],
    available: true,
    visibility: "PUBLIC",
    defaultBranch: "main",
    primaryBranch: "main",
    heads: [],
    targets: [],
    diagnostics: [],
  };
}
class Store implements CiProjectionStore {
  diagnostics: string[] = [];
  values = [projection()];
  listener: ((p: CiProjection) => void) | undefined;
  async snapshot(): Promise<readonly CiProjection[]> {
    return this.values;
  }
  list(): readonly CiProjection[] {
    return this.values;
  }
  onUpdate(listener: (p: CiProjection) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }
  update(p: CiProjection): void {
    this.values = [p];
    this.listener?.(p);
  }
  handleDelivery(_delivery: WebhookDelivery): void {}
  async close(): Promise<void> {}
}
async function daemon(store = new Store(), directory = fixture(), name = "events.sock") {
  const running = await startWebhookDaemon({
    secret: Buffer.alloc(32, 1),
    socketPath: join(directory, name),
    port: 0,
    ciStore: store,
  });
  cleanups.push(() => running.close());
  return running;
}
const catalog = JSON.parse(readFileSync(new URL("../events.schema.json", import.meta.url), "utf8"));
const validate = new Ajv({ strict: false, validateFormats: false }).compile(catalog);
async function peer(path: string) {
  const socket = createConnection(path);
  cleanups.push(() => {
    socket.destroy();
  });
  const records: unknown[] = [];
  const input = new JsonLines(MAX_FRAME_BYTES);
  socket.on("data", (chunk: Buffer) =>
    input.push(chunk, (frame) => {
      expect(validate(frame)).toBe(true);
      expect(socketFrameSchema.safeParse(frame).success).toBe(true);
      records.push(frame);
    }),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    records,
    send(method: string, params?: unknown, id = "test", extra = {}) {
      socket.write(
        `${JSON.stringify({ v: 1, type: "request", id, method, ...(params === undefined ? {} : { params }), ...extra })}\n`,
      );
    },
    async next(): Promise<Record<string, unknown>> {
      await until(() => records.length > 0);
      return records.shift() as Record<string, unknown>;
    },
  };
}
async function until(condition: () => boolean, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(5);
  }
}

test("published catalog matches runtime schemas and common defaults", () => {
  expect(catalog).toEqual(eventCatalog());
  expect(catalog.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(catalog.$defs.events.anyOf).toEqual([
    { $ref: "#/$defs/ci:<owner>:<repo>" },
    { $ref: "#/$defs/deliveries" },
  ]);
  for (const method of ["event.subscribe", "state.get"])
    for (const params of [undefined, null, {}]) {
      const frame = {
        v: 1,
        type: "request",
        id: "x",
        method,
        ...(params === undefined ? {} : { params }),
      };
      expect(requestsSchema.safeParse(frame).success).toBe(true);
      expect(validate(frame)).toBe(true);
    }
});

test("literal exact, trailing prefix and all filters share the common grammar", () => {
  for (const [filter, event, matches] of [
    ["*", "deliveries", true],
    ["ci:owner:repo", "ci:owner:repo", true],
    ["ci:owner:repo", "ci:owner:repo2", false],
    ["ci:owner:re*", "ci:owner:repo", true],
    ["a.b/*", "axb/c", false],
    ["a.b/*", "a.b/c", true],
  ] as const)
    expect(subscriptionMatches([filter], event)).toBe(matches);
});

test("replacement acknowledgment is the boundary; invalid requests preserve filters; clients are independent", async () => {
  const store = new Store();
  const running = await daemon(store);
  const first = await peer(running.socketPath);
  const second = await peer(running.socketPath);
  first.send("event.subscribe", { events: ["ci:owner:r*", "ci:owner:r*"] });
  expect(await first.next()).toMatchObject({ result: { events: ["ci:owner:r*"] } });
  second.send("event.subscribe", { events: ["future.event"] });
  await second.next();
  store.update(projection(2));
  expect(await first.next()).toMatchObject({
    event: "ci:owner:repo",
    data: { sequence: 1, projection: { revision: 2 } },
  });
  first.send("event.subscribe", { events: ["future.event"] });
  await first.next();
  store.update(projection(3));
  first.send("state.get");
  expect(await first.next()).toMatchObject({
    type: "response",
    result: { sequence: 2, projections: [{ revision: 3 }] },
  });
  expect(second.records).toHaveLength(0);
  for (const params of [
    { events: [] },
    { events: ["Ci:*"] },
    { events: ["ci:*:x"] },
    { events: ["x".repeat(129)] },
    { events: Array(33).fill("*") },
    { surprise: true },
  ]) {
    second.send("event.subscribe", params);
    expect(await second.next()).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  }
  first.send("event.subscribe");
  expect(await first.next()).toMatchObject({ result: { events: ["*"] } });
  for (const [id, extra, code] of [
    ["x", { v: 2 }, "invalid_request"],
    ["", {}, "invalid_request"],
    ["x".repeat(129), {}, "invalid_request"],
    ["x", { unexpected: true }, "invalid_request"],
  ] as const) {
    first.send("state.get", {}, id, extra);
    expect(await first.next()).toMatchObject({ ok: false, error: { code } });
  }
  first.send("missing.method", {});
  expect(await first.next()).toMatchObject({ error: { code: "unknown_method" } });
  first.send("state.get", { events: ["*"] });
  expect(await first.next()).toMatchObject({ error: { code: "invalid_params" } });
  store.update(projection(4));
  expect(await first.next()).toMatchObject({ event: "ci:owner:repo" });
});

test("updates during async initialization win over a stale initial read", async () => {
  const store = new Store();
  store.snapshot = async () => {
    store.update(projection(2));
    await Bun.sleep(5);
    return [projection(1)];
  };
  const running = await daemon(store);
  const client = await peer(running.socketPath);
  client.send("event.subscribe", null);
  await client.next();
  client.send("state.get", null);
  expect(await client.next()).toMatchObject({
    result: { sequence: 1, projections: [{ revision: 2 }] },
  });
  store.update(projection(3));
  expect(await client.next()).toMatchObject({ data: { sequence: 2, projection: { revision: 3 } } });
});

test("bounded projection reports incomplete, source failure unavailable, removal distinct from completion, restart changes lifetime", async () => {
  const frames: EventFrame[] = [];
  const feed = new EventFeed(
    (frame) => frames.push(frame),
    () => new Date(),
  );
  feed.set(projection());
  feed.remove("ci:owner:repo");
  expect(feed.snapshot().projections).toHaveLength(0);
  expect(frames[1]).toMatchObject({ data: { projection: null, sequence: 2 } });
  feed.set({ ...projection(), available: false });
  expect(frames[2]).toMatchObject({ data: { projection: { available: false } } });
  for (let i = 0; i < MAX_PROJECTIONS; i++) feed.set(projection(1, `repo${i}`), false);
  expect(feed.snapshot().inventory).toBe("incomplete");
  expect(feed.snapshot().projections).toHaveLength(MAX_PROJECTIONS);
  const oversized = new EventFeed(
    () => {},
    () => new Date(),
  );
  oversized.set({ ...projection(), paths: ["x".repeat(8 * 1024 * 1024)] });
  expect(oversized.snapshot()).toMatchObject({ inventory: "incomplete", projections: [] });
  const failed = new Store();
  failed.snapshot = async () => {
    throw new Error("source failed");
  };
  const running = await daemon(failed);
  const result = await snapshotChannels({ socketPath: running.socketPath, channels: ["*"] });
  expect(result.available).toBe(false);
  expect(result.diagnostics).toContain("CI source initialization failed");
  expect(
    new EventFeed(
      () => {},
      () => new Date(),
    ).instanceId,
  ).not.toBe(feed.instanceId);
  for (const frame of frames) expect(eventSchema.safeParse(frame).success).toBe(true);
});

test("framing preserves fragmented UTF-8 and bounds partial input and individual frames", async () => {
  const input = new JsonLines(100);
  const frames: unknown[] = [];
  const bytes = Buffer.from('{"text":"é🐈"}\n');
  for (const byte of bytes) input.push(Buffer.from([byte]), (frame) => frames.push(frame));
  expect(frames).toEqual([{ text: "é🐈" }]);
  expect(() => new JsonLines(3).push(Buffer.from("1234"), () => {})).toThrow("byte limit");
  expect(() => new JsonLines(3).push(Buffer.from("1234\n"), () => {})).toThrow("byte limit");
  expect(() => new JsonLines(100).push(Buffer.from([34, 255, 34, 10]), () => {})).toThrow();
  const running = await daemon();
  const client = await peer(running.socketPath);
  const closed = new Promise<void>((resolve) => client.socket.once("close", resolve));
  client.socket.write(Buffer.alloc(MAX_REQUEST_BYTES + 1, 120));
  await closed;
});

test("discovery selects a live absolute socket, rejects ambiguity, permissions and symlinks", async () => {
  const directory = fixture();
  const first = await daemon(new Store(), directory, "one.sock");
  expect(await discoverEventSocket({ directory })).toBe(first.socketPath);
  await daemon(new Store(), directory, "two.sock");
  await expect(discoverEventSocket({ directory })).rejects.toThrow("Ambiguous");
  expect(await discoverEventSocket({ socketPath: first.socketPath })).toBe(first.socketPath);
  chmodSync(first.socketPath, 0o666);
  await expect(discoverEventSocket({ socketPath: first.socketPath })).rejects.toThrow("private");
  chmodSync(first.socketPath, 0o600);
  const alias = join(directory, "alias.sock");
  symlinkSync(first.socketPath, alias);
  await expect(discoverEventSocket({ socketPath: alias })).rejects.toThrow("private");
  expect(ownedPrivate({ uid: (process.getuid?.() ?? 0) + 1, mode: 0o600 })).toBe(false);
  const output = Bun.spawn(
    [process.execPath, "src/cli.ts", "event-socket", "--socket", first.socketPath],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(output.stdout).text()).toBe(`${first.socketPath}\n`);
  expect(await output.exited).toBe(0);
});

async function fakeServer(
  handle: (
    socket: Socket,
    request: { id: string; method: string; params?: { events?: string[] } },
  ) => void,
) {
  const path = join(fixture(), "fake.sock");
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    const input = new JsonLines(MAX_REQUEST_BYTES);
    socket.on("data", (chunk: Buffer) =>
      input.push(chunk, (request) =>
        handle(socket, request as { id: string; method: string; params?: { events?: string[] } }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(async () => {
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { path, clients };
}
function response(socket: Socket, id: string, result: unknown): void {
  socket.write(`${JSON.stringify({ v: 1, type: "response", id, ok: true, result })}\n`);
}

test("subscriber waits for acknowledgment and snapshot, reconciles racing CI, and never drops transient deliveries", async () => {
  const feed = new EventFeed(
    () => {},
    () => new Date(),
  );
  feed.set(projection(1));
  let acknowledged = false;
  let initialized = false;
  const server = await fakeServer((socket, request) => {
    if (request.method === "event.subscribe") {
      setTimeout(() => {
        acknowledged = true;
        response(socket, request.id, { subscribed: true, events: ["*"] });
      }, 20);
    } else {
      const event = (p: CiProjection, sequence: number) => ({
        v: 1,
        type: "event",
        event: "ci:owner:repo",
        data: {
          ...feed.context(),
          sequence,
          emittedAt: "now",
          inventory: "complete",
          projection: p,
        },
      });
      socket.write(`${JSON.stringify(event(projection(2), 2))}\n`);
      socket.write(
        `${JSON.stringify({ v: 1, type: "event", event: "deliveries", data: { ...feed.context(), sequence: 1, emittedAt: "now", delivery: { schemaVersion: 1, receivedAt: "now", owner: "owner", repo: "repo", event: "push", deliveryId: "race", hookId: null, payload: { text: "café 🐈" } } } })}\n`,
      );
      socket.write(`${JSON.stringify(event(projection(4), 4))}\n`);
      response(socket, request.id, {
        ...feed.snapshot(),
        sequence: 3,
        projections: [projection(3)],
      });
      socket.write(`${JSON.stringify(event(projection(5), 5))}\n`);
      initialized = true;
    }
  });
  const observed: number[] = [];
  const deliveries: string[] = [];
  const availability: boolean[] = [];
  const subscription = subscribeChannels({
    socketPath: server.path,
    channels: ["*"],
    onSnapshot: (snapshot) => {
      observed.splice(0, observed.length, ...snapshot.projections.map((p) => p.revision));
    },
    onValue: (frame) => {
      if ("projection" in frame.data && frame.data.projection)
        observed.push(frame.data.projection.revision);
      if ("delivery" in frame.data) deliveries.push(frame.data.delivery.deliveryId);
    },
    onAvailability: (available) => {
      if (available) {
        expect(acknowledged).toBe(true);
        expect(initialized).toBe(true);
      }
      availability.push(available);
    },
  });
  cleanups.push(() => subscription.close());
  await until(() => observed.includes(5));
  expect(observed).toEqual([3, 4, 5]);
  expect(deliveries).toEqual(["race"]);
  expect(availability[0]).toBe(false);
  expect(availability.at(-1)).toBe(true);
});

test("reconnect replaces removed state and reinitializes after lifetime or generation changes", async () => {
  let lifetime = "first";
  let generation = 1;
  let rev = 1;
  let connectionCount = 0;
  const server = await fakeServer((socket, request) => {
    if (request.method === "event.subscribe") {
      connectionCount++;
      response(socket, request.id, { subscribed: true, events: ["ci:*"] });
    } else
      response(socket, request.id, {
        instanceId: lifetime,
        generation,
        sequence: 0,
        inventory: "complete",
        diagnostics: [],
        projections: rev ? [projection(rev)] : [],
      });
  });
  let revisions: number[] = [];
  const available: boolean[] = [];
  const subscription = subscribeChannels({
    socketPath: server.path,
    channels: ["ci:*"],
    reconnectDelayMs: 10,
    onSnapshot: (snapshot) => {
      revisions = snapshot.projections.map((p) => p.revision);
    },
    onValue: () => {},
    onAvailability: (value) => {
      available.push(value);
      if (!value) revisions = [];
    },
  });
  cleanups.push(() => subscription.close());
  await until(() => revisions[0] === 1);
  lifetime = "second";
  rev = 2;
  for (const socket of server.clients) socket.destroy();
  await until(() => revisions[0] === 2);
  generation = 2;
  rev = 0;
  for (const socket of server.clients)
    socket.write(
      `${JSON.stringify({ v: 1, type: "event", event: "ci:owner:repo", data: { instanceId: lifetime, generation, sequence: 1, emittedAt: "now", inventory: "complete", projection: null } })}\n`,
    );
  await until(() => connectionCount >= 3 && available.at(-1) === true);
  expect(revisions).toEqual([]);
  expect(available.filter((value) => !value).length).toBeGreaterThan(2);
});

test("clients reject oversized partial frames and time out before acknowledgment", async () => {
  const server = await fakeServer((socket) => {
    socket.write(Buffer.alloc(MAX_FRAME_BYTES + 1, 120));
  });
  const result = await snapshotChannels({
    socketPath: server.path,
    channels: ["*"],
    timeoutMs: 10000,
  });
  expect(result.available).toBe(false);
  expect(result.diagnostics.join()).toContain("byte limit");
  let unavailable = "";
  const subscription = subscribeChannels({
    socketPath: server.path,
    channels: ["*"],
    reconnectDelayMs: 10000,
    onValue: () => {},
    onSnapshot: () => {
      throw new Error("unexpected snapshot");
    },
    onAvailability: (_available, diagnostic) => {
      if (diagnostic?.includes("byte limit")) unavailable = diagnostic;
    },
  });
  cleanups.push(() => subscription.close());
  await until(() => unavailable.includes("byte limit"), 10000);
  const silent = await fakeServer(() => {});
  let timedOut = false;
  const waiting = subscribeChannels({
    socketPath: silent.path,
    channels: ["*"],
    timeoutMs: 20,
    reconnectDelayMs: 10000,
    onValue: () => {},
    onSnapshot: () => {},
    onAvailability: (available, diagnostic) => {
      expect(available).toBe(false);
      if (diagnostic?.includes("timed out")) timedOut = true;
    },
  });
  cleanups.push(() => waiting.close());
  await until(() => timedOut);
}, 15000);

test("server bounds connections while responsive consumers keep receiving", async () => {
  const running = await daemon();
  const sockets: Socket[] = [];
  for (let i = 0; i < 128; i++) {
    const client = await peer(running.socketPath);
    client.send("event.subscribe");
    await client.next();
    sockets.push(client.socket);
  }
  const extra = createConnection(running.socketPath);
  extra.on("error", () => {});
  await new Promise<void>((resolve) => extra.once("close", resolve));
  expect(sockets.every((socket) => !socket.destroyed)).toBe(true);
});

test("slow consumer isolation bounds queued output without delaying a healthy consumer", async () => {
  const store = new Store();
  const running = await daemon(store);
  const slow = await peer(running.socketPath);
  slow.send("event.subscribe");
  await slow.next();
  slow.socket.pause();
  const healthy = await peer(running.socketPath);
  healthy.send("event.subscribe");
  await healthy.next();
  const largePath = "x".repeat(1024 * 1024);
  for (let revision = 1; revision <= 70; revision++) {
    store.update({ ...projection(revision), paths: [largePath] });
    expect(await healthy.next()).toMatchObject({ data: { projection: { revision } } });
  }
  const closed = new Promise<void>((resolve) => slow.socket.once("close", resolve));
  slow.socket.resume();
  await closed;
  store.update(projection(71));
  expect(await healthy.next()).toMatchObject({ data: { projection: { revision: 71 } } });
}, 15000);

test("CLI observations and watcher snapshot/stream consumers use the new feed", async () => {
  const store = new Store();
  const directory = fixture();
  const running = await daemon(store, directory);
  const env = { ...process.env, AGENTSOURCE_WEBHOOK_SOCKET: running.socketPath };
  const observation = Bun.spawn([process.execPath, "src/cli.ts", "--json", "--root", directory], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const json = await new Response(observation.stdout).json();
  expect(await observation.exited).toBe(0);
  expect(json).toMatchObject({ ci: { available: true, projections: [{ revision: 1 }] } });
  const watcher = Bun.spawn(
    [process.execPath, "scripts/watch-webhook-channels.ts", "--snapshot", "ci:*"],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const frame = JSON.parse((await new Response(watcher.stdout).text()).trim());
  expect(await watcher.exited).toBe(0);
  expect(eventSchema.safeParse(frame).success).toBe(true);
  expect(frame).toMatchObject({ event: "ci:owner:repo", data: { projection: { revision: 1 } } });
  const streaming = Bun.spawn([process.execPath, "scripts/watch-webhook-channels.ts", "ci:*"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  cleanups.push(async () => {
    streaming.kill();
    await streaming.exited;
  });
  const reader = streaming.stdout.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"revision":1');
  store.update(projection(2));
  const next = await reader.read();
  expect(new TextDecoder().decode(next.value)).toContain('"revision":2');
  streaming.kill("SIGINT");
  expect(await streaming.exited).toBe(130);
});

test("real delivery frames validate against the catalog and UTF-8 request IDs survive fragmentation", async () => {
  const running = await daemon();
  const client = await peer(running.socketPath);
  const bytes = Buffer.from(
    `${JSON.stringify({ v: 1, type: "request", id: "café 🐈", method: "event.subscribe", params: { events: ["deliveries"] } })}\n`,
  );
  for (const byte of bytes) client.socket.write(Buffer.from([byte]));
  expect(await client.next()).toMatchObject({ id: "café 🐈", ok: true });
  const body = JSON.stringify({ repository: { full_name: "owner/repo" }, message: "café 🐈" });
  const delivery = await fetch(`http://${running.host}:${running.port}/owner/repo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "unicode-test",
      "x-hub-signature-256": `sha256=${createHmac("sha256", Buffer.alloc(32, 1)).update(body).digest("hex")}`,
    },
    body,
  });
  expect(delivery.status).toBe(202);
  expect(await client.next()).toMatchObject({
    event: "deliveries",
    data: { delivery: { payload: { message: "café 🐈" } } },
  });
});
