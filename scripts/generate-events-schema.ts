#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { eventCatalog } from "../src/event-schema.ts";

const path = fileURLToPath(new URL("../events.schema.json", import.meta.url));
await Bun.write(path, `${JSON.stringify(eventCatalog(), null, 2)}\n`);
const formatter = Bun.spawn(["bun", "x", "--no-install", "biome", "format", "--write", path], {
  stdout: "inherit",
  stderr: "inherit",
});
if (await formatter.exited) throw new Error("Could not format events.schema.json");
