import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  type AddressInfo,
  createConnection,
  createServer as createNetServer,
  type Socket,
} from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CiProjectionStore, ciChannel, createCiProjectionStore } from "./github-ci.ts";
import {
  CHANNEL_PROTOCOL_SCHEMA_VERSION,
  type ChannelEnvelope,
  type ChannelSnapshotRequest,
  type ChannelSnapshotResponse,
  type ChannelSubscription,
  WEBHOOK_DELIVERY_SCHEMA_VERSION,
  type WebhookDelivery,
} from "./types.ts";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_IN_FLIGHT_BODY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16;
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_SECRET_BYTES = 1024;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const EVENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const MAX_SUBSCRIPTION_BYTES = 16 * 1024;
const MAX_SUBSCRIPTION_PATTERNS = 64;
const SUBSCRIPTION_TIMEOUT_MS = 5_000;
const CI_CHANNEL_PATTERN = /^ci:[a-z0-9](?:[a-z0-9-]{0,38}):[a-z0-9_.-]{1,100}$/;
const CI_PREFIX_PATTERN = /^ci:(?:[a-z0-9](?:[a-z0-9-]{0,38}):)?\*$/;

export interface WebhookDaemonOptions {
  secret: Uint8Array;
  socketPath: string;
  port?: number;
  maxBodyBytes?: number;
  maxInFlightBodyBytes?: number;
  maxConcurrentRequests?: number;
  now?: () => Date;
  root?: string;
  ciStore?: CiProjectionStore;
}

export interface RunningWebhookDaemon {
  host: typeof LOOPBACK_HOST;
  port: number;
  socketPath: string;
  diagnostics: readonly string[];
  close: () => Promise<void>;
}

interface ChannelClient {
  socket: Socket;
  backpressured: boolean;
  subscription: string[] | null;
  input: string;
  handling: boolean;
}

class BodyTooLargeError extends Error {}
class ServerBusyError extends Error {}

interface BodyBudget {
  reserve: (bytes: number) => boolean;
  release: (bytes: number) => void;
}

type ChannelRequest = ChannelSubscription | ChannelSnapshotRequest;

function validChannelPatterns(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SUBSCRIPTION_PATTERNS)
    return null;
  const patterns = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate !== candidate.toLowerCase()) return null;
    if (
      candidate !== "deliveries" &&
      candidate !== "*" &&
      !CI_PREFIX_PATTERN.test(candidate) &&
      !CI_CHANNEL_PATTERN.test(candidate)
    )
      return null;
    patterns.add(candidate);
  }
  return [...patterns];
}

function parseChannelRequest(line: string): ChannelRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const schemaVersion = Reflect.get(value, "schemaVersion");
  if (schemaVersion !== CHANNEL_PROTOCOL_SCHEMA_VERSION) return null;
  if (Reflect.get(value, "method") === "snapshot") {
    const requestId = Reflect.get(value, "requestId");
    const channels = validChannelPatterns(Reflect.get(value, "channels"));
    if (typeof requestId !== "string" || requestId === "" || requestId.length > 256 || !channels)
      return null;
    return {
      schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
      requestId,
      method: "snapshot",
      channels,
    };
  }
  const subscribe = validChannelPatterns(Reflect.get(value, "subscribe"));
  return subscribe ? { schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION, subscribe } : null;
}

function subscriptionMatches(patterns: readonly string[], channel: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? channel.startsWith(pattern.slice(0, -1)) : pattern === channel,
  );
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function requirePrivateMode(mode: number, label: string): void {
  if ((mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or others`);
}

export async function readWebhookSecret(path: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(
      `could not securely open webhook secret ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("webhook secret must be a regular file");
    if (!ownedByCurrentUser(metadata.uid))
      throw new Error("webhook secret must be owned by this user");
    requirePrivateMode(metadata.mode, "webhook secret");
    let secret = await handle.readFile();
    if (secret.at(-1) === 0x0a) secret = secret.subarray(0, secret.length - 1);
    if (secret.at(-1) === 0x0d) secret = secret.subarray(0, secret.length - 1);
    if (secret.length < MINIMUM_SECRET_BYTES)
      throw new Error(`webhook secret must contain at least ${MINIMUM_SECRET_BYTES} bytes`);
    if (secret.length > MAXIMUM_SECRET_BYTES)
      throw new Error(`webhook secret must contain at most ${MAXIMUM_SECRET_BYTES} bytes`);
    const text = secret.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(secret) || text.includes("\0"))
      throw new Error("webhook secret must be valid UTF-8 without null bytes");
    return Buffer.from(secret);
  } finally {
    await handle.close();
  }
}

export async function ensureWebhookSecret(path: string): Promise<"created" | "existing"> {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new Error(
      `could not securely create a temporary webhook secret: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    try {
      await handle.writeFile(`${randomBytes(32).toString("hex")}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await readWebhookSecret(path);
      return "existing";
    }
    await syncDirectory(directory);
    await readWebhookSecret(path);
    return "created";
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await syncDirectory(directory);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function signatureMatches(body: Buffer, header: string | undefined, secret: Buffer): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const supplied = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(body).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function parseProjectPath(rawUrl: string | undefined): { owner: string; repo: string } | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "http://localhost");
  } catch {
    return null;
  }
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const segments = parsed.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(segments[1] ?? "");
    repo = decodeURIComponent(segments[2] ?? "");
  } catch {
    return null;
  }
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) return null;
  return { owner, repo };
}

async function readBody(
  request: IncomingMessage,
  limit: number,
  budget: BodyBudget,
): Promise<{ body: Buffer; reservedBytes: number }> {
  const declaredLength = singleHeader(request, "content-length");
  if (declaredLength !== undefined) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid content length");
    if (parsed > limit) throw new BodyTooLargeError("request body is too large");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  let reservedBytes = 0;
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > limit) throw new BodyTooLargeError("request body is too large");
      if (!budget.reserve(bytes.length))
        throw new ServerBusyError("webhook listener is at its body memory limit");
      reservedBytes += bytes.length;
      chunks.push(bytes);
    }
    return { body: Buffer.concat(chunks, length), reservedBytes };
  } catch (error) {
    budget.release(reservedBytes);
    throw error;
  }
}

function payloadProject(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const repository = Reflect.get(payload, "repository");
  if (typeof repository !== "object" || repository === null) return null;
  const fullName = Reflect.get(repository, "full_name");
  return typeof fullName === "string" ? fullName : null;
}

function respond(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function ensureSocketDirectory(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error(`delivery stream parent is not a real directory: ${directory}`);
  if (!ownedByCurrentUser(metadata.uid))
    throw new Error(`delivery stream parent must be owned by this user: ${directory}`);
  requirePrivateMode(metadata.mode, "delivery stream parent");
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const client = createConnection(path);
    const timer = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 250);
    client.once("connect", () => {
      clearTimeout(timer);
      client.destroy();
      resolve(true);
    });
    client.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function removeStaleSocket(path: string): Promise<void> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!metadata.isSocket() || metadata.isSymbolicLink())
    throw new Error(`refusing to replace non-socket delivery stream path: ${path}`);
  if (!ownedByCurrentUser(metadata.uid))
    throw new Error(`refusing to replace a delivery stream socket owned by another user: ${path}`);
  if (await socketAcceptsConnections(path))
    throw new Error(`another delivery stream is already listening at ${path}`);
  await unlink(path);
}

function listenUnix(server: ReturnType<typeof createNetServer>, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function listenHttp(server: ReturnType<typeof createHttpServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo | null;
      if (!address) reject(new Error("webhook listener did not report an address"));
      else resolve(address.port);
    });
  });
}

function closeServer(server: {
  close: (callback: (error?: Error) => void) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startWebhookDaemon(
  options: WebhookDaemonOptions,
): Promise<RunningWebhookDaemon> {
  const secret = Buffer.from(options.secret);
  if (secret.length < MINIMUM_SECRET_BYTES)
    throw new Error(`webhook secret must contain at least ${MINIMUM_SECRET_BYTES} bytes`);
  const port = options.port ?? 8787;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("invalid HTTP port");
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new Error("invalid maximum request body size");
  const maxInFlightBodyBytes = options.maxInFlightBodyBytes ?? DEFAULT_MAX_IN_FLIGHT_BODY_BYTES;
  if (!Number.isSafeInteger(maxInFlightBodyBytes) || maxInFlightBodyBytes < 1)
    throw new Error("invalid in-flight body memory limit");
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1)
    throw new Error("invalid concurrent request limit");

  await ensureSocketDirectory(options.socketPath);
  await removeStaleSocket(options.socketPath);

  const now = options.now ?? (() => new Date());
  const ciStore =
    options.ciStore ??
    (await createCiProjectionStore({
      root: options.root ?? join(homedir(), "code"),
      now,
    }));
  const clients = new Set<ChannelClient>();

  const envelope = (channel: string, data: unknown): ChannelEnvelope => ({
    schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
    channel,
    emittedAt: now().toISOString(),
    data,
  });

  const send = (
    client: ChannelClient,
    channel: string,
    data: unknown,
    queueInitialValue = false,
  ): void => {
    if (!client.subscription || !subscriptionMatches(client.subscription, channel)) return;
    if (client.backpressured && !queueInitialValue) {
      client.socket.destroy();
      return;
    }
    if (!client.socket.write(`${JSON.stringify(envelope(channel, data))}\n`))
      client.backpressured = true;
  };

  const broadcast = (channel: string, data: unknown): void => {
    for (const client of clients) send(client, channel, data);
  };

  const socketServer = createNetServer((client) => {
    const state: ChannelClient = {
      socket: client,
      backpressured: false,
      subscription: null,
      input: "",
      handling: false,
    };
    clients.add(state);
    client.setNoDelay(true);
    client.setEncoding("utf8");
    client.setTimeout(SUBSCRIPTION_TIMEOUT_MS, () => client.destroy());
    client.on("error", () => client.destroy());
    client.on("drain", () => {
      state.backpressured = false;
    });
    client.on("data", (chunk: string) => {
      if (state.subscription || state.handling) {
        client.destroy();
        return;
      }
      state.input += chunk;
      if (Buffer.byteLength(state.input, "utf8") > MAX_SUBSCRIPTION_BYTES) {
        client.destroy();
        return;
      }
      const newline = state.input.indexOf("\n");
      if (newline < 0) return;
      if (state.input.slice(newline + 1).trim() !== "") {
        client.destroy();
        return;
      }
      const request = parseChannelRequest(state.input.slice(0, newline));
      if (!request) {
        client.destroy();
        return;
      }
      state.input = "";
      state.handling = true;
      client.setTimeout(0);
      void ciStore
        .snapshot("method" in request ? request.channels : request.subscribe)
        .then((projections) => {
          if (client.destroyed) return;
          if ("method" in request) {
            const values = projections.map((projection) =>
              envelope(ciChannel(projection.owner, projection.repo), projection),
            );
            const response: ChannelSnapshotResponse = {
              schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
              requestId: request.requestId,
              ok: true,
              values,
            };
            client.end(`${JSON.stringify(response)}\n`);
            return;
          }
          state.subscription = request.subscribe;
          for (const projection of projections)
            send(state, ciChannel(projection.owner, projection.repo), projection, true);
        })
        .catch(() => client.destroy())
        .finally(() => {
          state.handling = false;
        });
    });
    client.on("close", () => clients.delete(state));
  });
  const stopCiUpdates = ciStore.onUpdate((projection) =>
    broadcast(ciChannel(projection.owner, projection.repo), projection),
  );
  const closeDeliveryStream = async (): Promise<void> => {
    const closing = closeServer(socketServer);
    for (const client of clients) client.socket.destroy();
    await closing;
  };
  let unixSocketBound = false;
  try {
    await listenUnix(socketServer, options.socketPath);
    unixSocketBound = true;
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    if (unixSocketBound) {
      await closeDeliveryStream().catch(() => undefined);
      await unlink(options.socketPath).catch(() => undefined);
    }
    stopCiUpdates();
    await ciStore.close();
    throw error;
  }

  let inFlightBodyBytes = 0;
  let inFlightRequests = 0;
  const bodyBudget: BodyBudget = {
    reserve: (bytes) => {
      if (inFlightBodyBytes + bytes > maxInFlightBodyBytes) return false;
      inFlightBodyBytes += bytes;
      return true;
    },
    release: (bytes) => {
      inFlightBodyBytes -= bytes;
    },
  };

  const httpServer = createHttpServer(async (request, response) => {
    if (inFlightRequests >= maxConcurrentRequests) {
      response.shouldKeepAlive = false;
      request.resume();
      respond(response, 503, { error: "webhook listener is at its request limit" });
      return;
    }
    inFlightRequests += 1;
    let reservedBodyBytes = 0;
    try {
      if (request.method !== "POST") {
        respond(response, 405, { error: "method must be POST" });
        return;
      }
      const project = parseProjectPath(request.url);
      if (!project) {
        respond(response, 404, { error: "path must be /<owner>/<repo>" });
        return;
      }
      const contentType = singleHeader(request, "content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        respond(response, 415, { error: "content type must be application/json" });
        return;
      }
      const read = await readBody(request, maxBodyBytes, bodyBudget);
      const { body } = read;
      reservedBodyBytes = read.reservedBytes;
      if (!signatureMatches(body, singleHeader(request, "x-hub-signature-256"), secret)) {
        respond(response, 401, { error: "invalid signature" });
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        respond(response, 400, { error: "body must be valid JSON" });
        return;
      }
      const expectedProject = `${project.owner}/${project.repo}`;
      if (payloadProject(payload)?.toLowerCase() !== expectedProject.toLowerCase()) {
        respond(response, 422, { error: "payload repository does not match request path" });
        return;
      }
      const event = singleHeader(request, "x-github-event");
      const deliveryId = singleHeader(request, "x-github-delivery");
      if (
        !event ||
        !EVENT_PATTERN.test(event) ||
        !deliveryId ||
        !DELIVERY_ID_PATTERN.test(deliveryId)
      ) {
        respond(response, 400, { error: "missing or invalid GitHub delivery headers" });
        return;
      }
      const hookId = singleHeader(request, "x-github-hook-id") ?? null;
      if (hookId !== null && !/^\d{1,32}$/.test(hookId)) {
        respond(response, 400, { error: "invalid GitHub hook id" });
        return;
      }
      const delivery: WebhookDelivery = {
        schemaVersion: WEBHOOK_DELIVERY_SCHEMA_VERSION,
        receivedAt: now().toISOString(),
        owner: project.owner,
        repo: project.repo,
        event,
        deliveryId,
        hookId,
        payload,
      };
      broadcast("deliveries", delivery);
      ciStore.handleDelivery(delivery);
      respond(response, 202, { accepted: true, deliveryId });
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        respond(response, 413, { error: error.message });
      } else if (error instanceof ServerBusyError) {
        response.shouldKeepAlive = false;
        request.resume();
        respond(response, 503, { error: error.message });
      } else {
        respond(response, 400, {
          error: error instanceof Error ? error.message : "could not read request",
        });
      }
    } finally {
      bodyBudget.release(reservedBodyBytes);
      inFlightRequests -= 1;
    }
  });
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 64;
  httpServer.maxConnections = maxConcurrentRequests * 2;

  let boundPort: number;
  try {
    boundPort = await listenHttp(httpServer, port);
  } catch (error) {
    await closeDeliveryStream();
    await unlink(options.socketPath).catch(() => undefined);
    stopCiUpdates();
    await ciStore.close();
    throw error;
  }

  let closed = false;
  return {
    host: LOOPBACK_HOST,
    port: boundPort,
    socketPath: options.socketPath,
    diagnostics: ciStore.diagnostics,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all([closeServer(httpServer), closeDeliveryStream()]);
      stopCiUpdates();
      await ciStore.close();
      await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
