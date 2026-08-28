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

async function start(options: { maxBodyBytes?: number } = {}): Promise<RunningWebhookDaemon> {
  const fixture = mkdtempSync(join(tmpdir(), "agentsource-webhooks-"));
  fixtures.push(fixture);
  const daemon = await startWebhookDaemon({
    secret: SECRET,
    socketPath: join(fixture, "webhooks.sock"),
    port: 0,
    now: () => new Date("2026-08-27T20:00:00.000Z"),
    ...options,
  });
  daemons.push(daemon);
  return daemon;
}

async function connect(path: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextRecord(socket: Socket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

function signature(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
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
      schemaVersion: 1,
      receivedAt: "2026-08-27T20:00:00.000Z",
      owner: "possibilities",
      repo: "agentsource",
      event: "push",
      deliveryId: "delivery-123",
      hookId: "42",
      payload,
    });
    expect(statSync(daemon.socketPath).mode & 0o777).toBe(0o600);
    socket.destroy();
  });

  test("flushes one large delivery before treating a client as lagging", async () => {
    const daemon = await start();
    const socket = await connect(daemon.socketPath);
    const recordPromise = nextRecord(socket);
    const payload = {
      repository: { full_name: "possibilities/agentsource" },
      data: "x".repeat(64 * 1024),
    };
    expect((await deliver(daemon, JSON.stringify(payload))).status).toBe(202);
    expect(((await recordPromise).payload as typeof payload).data).toHaveLength(64 * 1024);
    socket.destroy();
  });

  test("rejects invalid signatures and project mismatches without broadcasting them", async () => {
    const daemon = await start();
    const socket = await connect(daemon.socketPath);
    const recordPromise = nextRecord(socket);
    const body = JSON.stringify({ repository: { full_name: "possibilities/agentsource" } });

    const unsigned = await deliver(daemon, body, { "x-hub-signature-256": "sha256=00" });
    expect(unsigned.status).toBe(401);
    const mismatched = await deliver(daemon, body, {}, "/possibilities/something-else");
    expect(mismatched.status).toBe(422);
    const accepted = await deliver(daemon, body, { "x-github-delivery": "delivery-good" });
    expect(accepted.status).toBe(202);
    expect((await recordPromise).deliveryId).toBe("delivery-good");
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
