import { lstat, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { defaultWebhookSocketPath, snapshotChannels } from "./channel-client.ts";

export function ownedPrivate(metadata: { uid: number; mode: number }): boolean {
  return (
    (typeof process.getuid !== "function" || metadata.uid === process.getuid()) &&
    (metadata.mode & 0o077) === 0
  );
}
async function privateSocket(path: string): Promise<void> {
  const parent = await lstat(dirname(path));
  const socket = await lstat(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || !ownedPrivate(parent))
    throw new Error("Event socket parent must be a private directory owned by this user");
  if (!socket.isSocket() || socket.isSymbolicLink() || !ownedPrivate(socket))
    throw new Error("Event socket must be private and owned by this user");
}
async function live(path: string): Promise<boolean> {
  return new Promise((resolveLive) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveLive(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolveLive(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolveLive(false);
    });
  });
}
/** Select an exact endpoint without starting a daemon or reading credentials. */
export async function discoverEventSocket(
  options: { socketPath?: string; directory?: string } = {},
): Promise<string> {
  const paths = options.directory
    ? (await readdir(resolve(options.directory)))
        .filter((name) => name.endsWith(".sock"))
        .map((name) => join(resolve(options.directory as string), name))
    : [resolve(options.socketPath ?? defaultWebhookSocketPath())];
  const candidates: string[] = [];
  for (const path of paths) {
    await privateSocket(path);
    if (await live(path)) candidates.push(path);
  }
  if (candidates.length !== 1)
    throw new Error(
      candidates.length ? "Ambiguous event socket; select --socket PATH" : "No live event socket",
    );
  const path = candidates[0];
  if (!path) throw new Error("No live event socket");
  // Correlate an actual protocol response; incomplete CI still identifies a live feed.
  const result = await snapshotChannels({ socketPath: path, channels: ["*"], timeoutMs: 1000 });
  if (result.diagnostics.some((line) => line.startsWith("CI socket unavailable:")))
    throw new Error("Endpoint is not a live Agentsource event feed");
  return path;
}
