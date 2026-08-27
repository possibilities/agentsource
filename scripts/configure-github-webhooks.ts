#!/usr/bin/env bun

import { runGitHubWebhookSetupCli } from "../src/github-webhooks.ts";

process.exit(await runGitHubWebhookSetupCli());
