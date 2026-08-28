#!/usr/bin/env bun

import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help) {
  process.stdout.write(`Usage: watch-webhook-channels [CHANNEL_OR_PREFIX ...]

Subscribe to agentsource's Unix socket and print channel envelopes as NDJSON.
Defaults to ci:*. Set AGENTSOURCE_WEBHOOK_SOCKET to use another socket.

Examples:
  watch-webhook-channels 'ci:*'
  watch-webhook-channels deliveries
  watch-webhook-channels deliveries 'ci:*' | jq --unbuffered -c .
`);
  process.exit(0);
}

const subscribe = process.argv.slice(2);
if (subscribe.length === 0) subscribe.push("ci:*");
const socketPath =
  process.env.AGENTSOURCE_WEBHOOK_SOCKET ??
  join(homedir(), ".local", "state", "agentsource", "webhooks.sock");

const socket = createConnection(socketPath);
socket.setEncoding("utf8");
socket.once("connect", () => {
  socket.write(`${JSON.stringify({ schemaVersion: 1, subscribe })}\n`);
});
socket.on("data", (chunk) => process.stdout.write(chunk));
socket.once("error", (error) => {
  process.stderr.write(`watch-webhook-channels: ${error.message}\n`);
  process.exitCode = 1;
});
