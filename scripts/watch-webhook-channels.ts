#!/usr/bin/env bun

import { snapshotChannels, snapshotValues, subscribeChannels } from "../src/channel-client.ts";

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
const print = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};
if (snapshot) {
  const result = await snapshotChannels({ channels });
  for (const value of result.values) print(value);
  if (!result.available) {
    process.stderr.write(`${result.diagnostics.join("; ") || "CI projection incomplete"}\n`);
    process.exitCode = 1;
  }
} else {
  const subscription = subscribeChannels({
    channels,
    onValue: print,
    onSnapshot: (state) => {
      for (const value of snapshotValues(state, channels)) print(value);
    },
    onAvailability: (available, diagnostic) => {
      if (!available && diagnostic) process.stderr.write(`${diagnostic}\n`);
    },
  });
  process.once("SIGINT", () => {
    subscription.close();
    process.exitCode = 130;
  });
  process.once("SIGTERM", () => {
    subscription.close();
    process.exitCode = 143;
  });
}
