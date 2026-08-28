import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_PROTOCOL_SCHEMA_VERSION,
  type ChannelEnvelope,
  type ChannelSnapshotResponse,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

export function defaultWebhookSocketPath(): string {
  return (
    process.env.AGENTSOURCE_WEBHOOK_SOCKET ??
    join(homedir(), ".local", "state", "agentsource", "webhooks.sock")
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEnvelope(value: unknown): ChannelEnvelope | null {
  if (typeof value !== "object" || value === null) return null;
  const schemaVersion = Reflect.get(value, "schemaVersion");
  const channel = Reflect.get(value, "channel");
  const emittedAt = Reflect.get(value, "emittedAt");
  if (
    schemaVersion !== CHANNEL_PROTOCOL_SCHEMA_VERSION ||
    typeof channel !== "string" ||
    typeof emittedAt !== "string"
  )
    return null;
  return { schemaVersion, channel, emittedAt, data: Reflect.get(value, "data") };
}

export interface ChannelSnapshotResult {
  available: boolean;
  values: ChannelEnvelope[];
  diagnostics: string[];
}

export async function snapshotChannels(options: {
  channels: readonly string[];
  socketPath?: string;
  timeoutMs?: number;
  requestId?: string;
}): Promise<ChannelSnapshotResult> {
  const socketPath = options.socketPath ?? defaultWebhookSocketPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestId = options.requestId ?? `agentsource-${process.pid}-${Date.now()}`;
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let input = "";
    const finish = (result: ChannelSnapshotResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const fail = (message: string): void =>
      finish({ available: false, values: [], diagnostics: [`CI socket unavailable: ${message}`] });
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs}ms`), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
          requestId,
          method: "snapshot",
          channels: [...options.channels],
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > 32 * 1024 * 1024) {
        fail("snapshot response exceeded 32 MiB");
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(input.slice(0, newline)) as ChannelSnapshotResponse;
        if (
          parsed.schemaVersion !== CHANNEL_PROTOCOL_SCHEMA_VERSION ||
          parsed.requestId !== requestId ||
          parsed.ok !== true ||
          !Array.isArray(parsed.values)
        ) {
          fail("daemon returned an invalid snapshot response");
          return;
        }
        const values = parsed.values.map(parseEnvelope);
        if (values.some((value) => value === null)) {
          fail("daemon returned an invalid channel envelope");
          return;
        }
        finish({ available: true, values: values as ChannelEnvelope[], diagnostics: [] });
      } catch (error) {
        fail(`daemon returned invalid JSON: ${errorText(error)}`);
      }
    });
    socket.once("error", (error) => fail(error.message));
    socket.once("end", () => {
      if (!settled) fail("daemon closed before returning a snapshot");
    });
  });
}

export interface ChannelSubscriptionHandle {
  close: () => void;
}

/** Subscribe with automatic reconnect; callbacks never make the TUI lifecycle fail. */
export function subscribeChannels(options: {
  channels: readonly string[];
  socketPath?: string;
  onValue: (value: ChannelEnvelope) => void;
  onAvailability: (available: boolean, diagnostic?: string) => void;
}): ChannelSubscriptionHandle {
  const socketPath = options.socketPath ?? defaultWebhookSocketPath();
  let stopped = false;
  let socket: Socket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const connect = (): void => {
    if (stopped) return;
    let input = "";
    const current = createConnection(socketPath);
    socket = current;
    current.setEncoding("utf8");
    current.once("connect", () => {
      options.onAvailability(true);
      current.write(
        `${JSON.stringify({
          schemaVersion: CHANNEL_PROTOCOL_SCHEMA_VERSION,
          subscribe: [...options.channels],
        })}\n`,
      );
    });
    current.on("data", (chunk: string) => {
      input += chunk;
      let newline = input.indexOf("\n");
      while (newline >= 0) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        try {
          const envelope = parseEnvelope(JSON.parse(line) as unknown);
          if (envelope) options.onValue(envelope);
        } catch {
          // A malformed daemon record is ignored; reconnect will replace state.
        }
        newline = input.indexOf("\n");
      }
    });
    current.once("error", (error) => {
      options.onAvailability(false, `CI socket unavailable: ${error.message}`);
    });
    current.once("close", () => {
      if (socket === current) socket = null;
      if (stopped) return;
      options.onAvailability(false, "CI socket unavailable: connection closed");
      reconnect = setTimeout(connect, RECONNECT_DELAY_MS);
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
