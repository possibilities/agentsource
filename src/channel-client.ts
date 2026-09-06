import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JsonLines } from "./event-framing.ts";
import {
  type EventFrame,
  type EventSnapshot,
  eventSchema,
  filtersSchema,
  MAX_FRAME_BYTES,
  MAX_QUEUED_BYTES,
  responseSchema,
  snapshotSchema,
  subscribedSchema,
  subscriptionMatches,
} from "./event-schema.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
export function defaultWebhookSocketPath(): string {
  return resolve(
    process.env.AGENTSOURCE_WEBHOOK_SOCKET ??
      join(homedir(), ".local", "state", "agentsource", "webhooks.sock"),
  );
}
export interface ChannelSnapshotResult {
  available: boolean;
  values: EventFrame[];
  diagnostics: string[];
}
export function snapshotValues(snapshot: EventSnapshot, channels: readonly string[]): EventFrame[] {
  return snapshot.projections.flatMap((projection) => {
    const event = `ci:${projection.owner.toLowerCase()}:${projection.repo.toLowerCase()}`;
    return subscriptionMatches(channels, event)
      ? [
          {
            v: 1 as const,
            type: "event" as const,
            event,
            data: {
              instanceId: snapshot.instanceId,
              generation: snapshot.generation,
              sequence: snapshot.sequence,
              emittedAt: projection.projectedAt,
              inventory: snapshot.inventory,
              projection,
            },
          },
        ]
      : [];
  });
}
function request(socket: Socket, id: string, method: string, params: object): void {
  socket.write(`${JSON.stringify({ v: 1, type: "request", id, method, params })}\n`);
}
export async function snapshotChannels(options: {
  channels: readonly string[];
  socketPath?: string;
  timeoutMs?: number;
  requestId?: string;
}): Promise<ChannelSnapshotResult> {
  filtersSchema.parse(options.channels);
  const id = options.requestId ?? "state";
  if (!id || id.length > 128) throw new Error("Invalid request ID");
  return new Promise((resolveResult) => {
    const socket = createConnection(options.socketPath ?? defaultWebhookSocketPath());
    const input = new JsonLines(MAX_FRAME_BYTES);
    let settled = false;
    const finish = (result: ChannelSnapshotResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveResult(result);
    };
    const fail = (message: string): void =>
      finish({ available: false, values: [], diagnostics: [`CI socket unavailable: ${message}`] });
    const timer = setTimeout(
      () => fail("snapshot timed out"),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    socket.once("connect", () => request(socket, id, "state.get", {}));
    socket.on("data", (chunk: Buffer) => {
      try {
        input.push(chunk, (raw) => {
          const response = responseSchema.parse(raw);
          if (response.id !== id || !response.ok) throw new Error("Invalid snapshot response");
          const snapshot = snapshotSchema.parse(response.result);
          finish({
            available: snapshot.inventory === "complete",
            values: snapshotValues(snapshot, options.channels),
            diagnostics: snapshot.diagnostics,
          });
        });
      } catch (error) {
        fail(String(error));
      }
    });
    socket.once("error", (error) => fail(error.message));
    socket.once("close", () => fail("connection closed"));
  });
}
export interface ChannelSubscriptionHandle {
  close: () => void;
}
/** Reconcile current state on every connection; transient deliveries bypass snapshot watermarks. */
export function subscribeChannels(options: {
  channels: readonly string[];
  socketPath?: string;
  timeoutMs?: number;
  reconnectDelayMs?: number;
  onValue: (value: EventFrame) => void;
  onSnapshot: (snapshot: EventSnapshot) => void;
  onAvailability: (available: boolean, diagnostic?: string) => void;
}): ChannelSubscriptionHandle {
  const channels = [...new Set(filtersSchema.parse(options.channels))];
  let stopped = false;
  let socket: Socket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const connect = (): void => {
    if (stopped) return;
    options.onAvailability(false, "CI feed initializing");
    const current = createConnection(options.socketPath ?? defaultWebhookSocketPath());
    socket = current;
    const input = new JsonLines(MAX_FRAME_BYTES);
    let phase: "subscribe" | "snapshot" | "live" = "subscribe";
    let context: EventSnapshot | null = null;
    let buffered: EventFrame[] = [];
    let bufferedBytes = 0;
    const timer = setTimeout(
      () => current.destroy(new Error("CI feed initialization timed out")),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const apply = (frame: EventFrame): void => {
      if (frame.event === "deliveries") {
        options.onValue(frame);
        return;
      }
      if (!context) return;
      if (
        frame.data.instanceId !== context.instanceId ||
        frame.data.generation !== context.generation
      ) {
        // A replacement invalidates all prior local state; reconnect and obtain its snapshot.
        current.destroy(new Error("CI producer state replaced"));
        return;
      }
      if (frame.data.sequence <= context.sequence) return;
      context.sequence = frame.data.sequence;
      if ("inventory" in frame.data)
        options.onAvailability(
          frame.data.inventory === "complete",
          frame.data.inventory === "complete" ? undefined : "CI projection incomplete",
        );
      options.onValue(frame);
    };
    current.once("connect", () => request(current, "sub", "event.subscribe", { events: channels }));
    current.on("data", (chunk: Buffer) => {
      try {
        input.push(chunk, (raw) => {
          if (current.destroyed) return;
          const event = eventSchema.safeParse(raw);
          if (event.success) {
            const frame = event.data;
            if (frame.event === "deliveries") options.onValue(frame);
            else if (phase === "live") apply(frame);
            else {
              bufferedBytes += Buffer.byteLength(JSON.stringify(raw));
              if (bufferedBytes > MAX_QUEUED_BYTES || buffered.length >= 4096)
                throw new Error("CI initialization buffer exceeded");
              buffered.push(frame);
            }
            return;
          }
          const response = responseSchema.parse(raw);
          if (!response.ok) throw new Error(response.error.message);
          if (phase === "subscribe" && response.id === "sub") {
            const acknowledgment = subscribedSchema.parse(response.result);
            if (JSON.stringify(acknowledgment.events) !== JSON.stringify(channels))
              throw new Error("Subscription acknowledgment does not match filters");
            phase = "snapshot";
            request(current, "state", "state.get", {});
          } else if (phase === "snapshot" && response.id === "state") {
            context = snapshotSchema.parse(response.result);
            options.onSnapshot(structuredClone(context));
            phase = "live";
            options.onAvailability(
              context.inventory === "complete",
              context.diagnostics.join("; ") || undefined,
            );
            for (const frame of buffered) apply(frame);
            buffered = [];
            bufferedBytes = 0;
            clearTimeout(timer);
          } else throw new Error("Unexpected response");
        });
      } catch (error) {
        current.destroy(new Error(String(error)));
      }
    });
    current.once("error", (error) =>
      options.onAvailability(false, `CI socket unavailable: ${error.message}`),
    );
    current.once("close", () => {
      clearTimeout(timer);
      if (socket === current) socket = null;
      if (stopped) return;
      options.onAvailability(false, "CI socket unavailable: connection closed");
      reconnect = setTimeout(connect, options.reconnectDelayMs ?? 1_000);
    });
  };
  connect();
  return {
    close: () => {
      stopped = true;
      if (reconnect) clearTimeout(reconnect);
      socket?.destroy();
      socket = null;
    },
  };
}
