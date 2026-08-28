#!/usr/bin/env bun

import { resolve } from "node:path";
import { ensureWebhookSecret } from "../src/webhooks.ts";

const path = process.argv[2];
if (!path || process.argv.length !== 3) {
  process.stderr.write("Usage: scripts/ensure-webhook-secret.ts PATH\n");
  process.exit(2);
}

try {
  const result = await ensureWebhookSecret(resolve(path));
  process.stdout.write(`Webhook secret ${result}; value not displayed.\n`);
} catch (error) {
  process.stderr.write(
    `Could not ensure webhook secret: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
