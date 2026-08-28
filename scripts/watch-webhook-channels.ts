#!/usr/bin/env bun

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help) {
  process.stdout.write(`Usage: watch-webhook-channels [--snapshot] [CHANNEL_OR_PREFIX ...]

Subscribe to agentsource's Unix socket and print channel envelopes as NDJSON,
or request one bounded snapshot and exit.
Defaults to ci:*. Set AGENTSOURCE_WEBHOOK_SOCKET to use another socket.

Examples:
  watch-webhook-channels 'ci:*'
  watch-webhook-channels --snapshot 'ci:*'
  watch-webhook-channels deliveries
  watch-webhook-channels deliveries 'ci:*' | jq --unbuffered -c .
`);
  process.exit(0);
}

const args = process.argv.slice(2);
const snapshot = args[0] === "--snapshot";
const channels = snapshot ? args.slice(1) : args;
if (channels.length === 0) channels.push("ci:*");
const socketPath =
  process.env.AGENTSOURCE_WEBHOOK_SOCKET ??
  join(homedir(), ".local", "state", "agentsource", "webhooks.sock");

const socket = createConnection(socketPath);
socket.setEncoding("utf8");
socket.once("connect", () => {
  socket.write(
    `${JSON.stringify(
      snapshot
        ? { schemaVersion: 1, requestId: "watcher", method: "snapshot", channels }
        : { schemaVersion: 1, subscribe: channels },
    )}\n`,
  );
});
let input = "";
socket.on("data", (chunk) => {
  if (!snapshot) {
    process.stdout.write(chunk);
    return;
  }
  input += chunk;
  const newline = input.indexOf("\n");
  if (newline < 0) return;
  const response = JSON.parse(input.slice(0, newline)) as { values?: unknown[] };
  for (const value of response.values ?? []) process.stdout.write(`${JSON.stringify(value)}\n`);
});
socket.once("error", (error) => {
  process.stderr.write(`watch-webhook-channels: ${error.message}\n`);
  process.exitCode = 1;
});
