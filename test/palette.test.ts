import { describe, expect, test } from "bun:test";
import * as core from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createCommandPalette, type PaletteCommand, paletteMatches } from "../src/tui/palette.ts";

const TOKENS = {
  panel: "#131a1e",
  line: "#2a343a",
  accent: "#67d7c9",
  muted: "#7d8a91",
  text: "#d8e2e7",
};

const commands = (ran: string[] = []): PaletteCommand[] => [
  { id: "refresh", key: "R", label: "refresh projects", onRun: () => ran.push("refresh") },
  { id: "up", key: "K", label: "scroll up", onRun: () => ran.push("up") },
  { id: "down", key: "J", label: "scroll down", onRun: () => ran.push("down") },
  { id: "quit", key: "Q", label: "quit", onRun: () => ran.push("quit") },
];

const press = (name: string, extra: Partial<{ ctrl: boolean; sequence: string }> = {}) => ({
  name,
  ctrl: extra.ctrl ?? false,
  sequence: extra.sequence ?? name,
});

describe("palette", () => {
  test("filters by label and key", () => {
    const all = commands();
    expect(paletteMatches(all, "scroll").map((command) => command.id)).toEqual(["up", "down"]);
    expect(paletteMatches(all, "q").map((command) => command.id)).toEqual(["quit"]);
  });

  test("opens on ctrl+k, filters, runs, and preserves ctrl+c", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 80, height: 24 });

    expect(palette.handleKey(press("c", { ctrl: true }))).toBe(false);
    expect(palette.handleKey(press("k", { ctrl: true }))).toBe(true);
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("COMMANDS");
    for (const letter of "quit") palette.handleKey(press(letter));
    await setup.flush();
    expect(setup.captureCharFrame()).not.toContain("scroll down");
    palette.handleKey(press("return", { sequence: "\r" }));
    expect(ran).toEqual(["quit"]);
    expect(palette.isOpen()).toBe(false);
    setup.renderer.destroy();
  });

  test("fits a shallow narrow viewport and pointer rows run commands", async () => {
    const setup = await createTestRenderer({ width: 40, height: 7 });
    const ran: string[] = [];
    const palette = createCommandPalette(core, setup.renderer, TOKENS);
    setup.renderer.root.add(palette.root);
    palette.update({ commands: commands(ran), width: 40, height: 7 });
    palette.handleKey(press("k", { ctrl: true }));
    await setup.flush();
    expect(palette.root.width).toBeLessThanOrEqual(36);
    expect(palette.root.y + palette.root.height).toBeLessThanOrEqual(7);
    const row = setup.renderer.root.findDescendantById("source-command-down");
    expect(row).toBeInstanceOf(core.BoxRenderable);
    if (!(row instanceof core.BoxRenderable)) throw new Error("command row was not rendered");
    await setup.mockMouse.click(row.x + 2, row.y);
    expect(ran).toEqual(["down"]);
    setup.renderer.destroy();
  });
});
