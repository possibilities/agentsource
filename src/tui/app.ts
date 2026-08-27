import { scanProjects } from "../git.ts";
import { type Line, renderFailurePanel, renderScan } from "../render.ts";
import type { ScanResult } from "../types.ts";
import { createCommandPalette } from "./palette.ts";
import { GLYPHS, SIGNAL_ROOM } from "./theme.ts";

export interface TuiOptions {
  root?: string;
}

/** Run the chromeless Signal Room project instrument. */
export async function runTui(options: TuiOptions = {}): Promise<void> {
  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    autoFocus: false,
    exitSignals: ["SIGTERM", "SIGHUP", "SIGQUIT"],
    backgroundColor: SIGNAL_ROOM.canvas,
  });

  const palette = createCommandPalette(core, renderer, {
    panel: SIGNAL_ROOM.panel,
    line: SIGNAL_ROOM.line,
    accent: SIGNAL_ROOM.accent,
    muted: SIGNAL_ROOM.muted,
    text: SIGNAL_ROOM.text,
  });

  const root = new core.BoxRenderable(renderer, {
    id: "source-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: SIGNAL_ROOM.canvas,
    onMouseUp: (event) => {
      if (palette.isOpen()) {
        event.stopPropagation();
        palette.close();
      } else if (failed()) {
        event.stopPropagation();
        void refresh();
      }
    },
  });
  renderer.root.add(root);

  const scroll = new core.ScrollBoxRenderable(renderer, {
    id: "source-scroll",
    width: "100%",
    flexGrow: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.canvas,
    viewportCulling: true,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      scroll.scrollBy({ x: 0, y: direction === "down" ? 2 : -2 });
      event.preventDefault();
      event.stopPropagation();
      renderer.requestRender();
    },
  });
  const body = new core.TextRenderable(renderer, {
    id: "source-body",
    content: "",
    wrapMode: "none",
  });
  scroll.add(body);
  root.add(scroll);
  try {
    scroll.verticalScrollBar.visible = false;
    scroll.horizontalScrollBar.visible = false;
  } catch {
    // Older OpenTUI builds do not expose scrollbar setters.
  }

  renderer.root.add(palette.root);

  const failurePanel = new core.BoxRenderable(renderer, {
    id: "source-failure-panel",
    width: "100%",
    height: 1,
    visible: false,
    paddingLeft: 2,
    paddingRight: 2,
    backgroundColor: SIGNAL_ROOM.panel,
    onMouseUp: (event) => {
      event.stopPropagation();
      if (palette.isOpen()) palette.close();
      else void refresh();
    },
  });
  const failureText = new core.TextRenderable(renderer, {
    id: "source-failure-text",
    content: "",
    height: 1,
    wrapMode: "none",
  });
  failurePanel.add(failureText);
  root.add(failurePanel);

  const refreshChip = new core.BoxRenderable(renderer, {
    id: "source-refresh-chip",
    position: "absolute",
    top: 1,
    right: 2,
    zIndex: 50,
    visible: false,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor: SIGNAL_ROOM.panel,
  });
  refreshChip.add(
    new core.TextRenderable(renderer, {
      content: `${GLYPHS.refresh} SCANNING`,
      fg: SIGNAL_ROOM.accent,
      height: 1,
      wrapMode: "none",
    }),
  );
  renderer.root.add(refreshChip);

  let observation: ScanResult | null = null;
  let scanning = false;
  let closed = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const styled = (lines: readonly Line[]): InstanceType<typeof core.StyledText> => {
    const chunks: ReturnType<typeof core.bold>[] = [];
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) chunks.push(core.fg(SIGNAL_ROOM.text)("\n"));
      for (const part of line) {
        let chunk = core.fg(SIGNAL_ROOM[part.token])(part.text);
        if (part.bold === true) chunk = core.bold(chunk);
        chunks.push(chunk);
      }
    });
    return new core.StyledText(chunks);
  };

  const scrollBy = (amount: number): void => {
    scroll.scrollBy({ x: 0, y: amount });
    renderer.requestRender();
  };
  const scrollTo = (amount: number): void => {
    scroll.scrollTop = amount;
    renderer.requestRender();
  };
  const failed = (): boolean =>
    observation !== null && observation.projects.length === 0 && observation.diagnostics.length > 0;
  const onKeypress = (key: {
    name: string;
    ctrl: boolean;
    meta?: boolean;
    sequence?: string;
    eventType?: string;
  }): void => {
    if (palette.handleKey(key)) return;
    const name = key.name;
    if (name === "q" || (key.ctrl && name === "c")) {
      shutdown();
      return;
    }
    if (name === "r") {
      void refresh();
      return;
    }
    if (name === "j" || name === "down") scrollBy(2);
    else if (name === "k" || name === "up") scrollBy(-2);
    else if (name === "g") scrollTo(0);
    else if (name === "G" || name === "end") scrollTo(Number.MAX_SAFE_INTEGER);
  };
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    renderer.off("resize", paint);
    renderer.keyInput.off("keypress", onKeypress);
    process.off("SIGTERM", shutdown);
    process.off("SIGHUP", shutdown);
    renderer.destroy();
    finish();
  };

  const paint = (): void => {
    const columns = renderer.width || process.stdout.columns || 80;
    const rows = renderer.height || process.stdout.rows || 24;
    const width = Math.max(24, columns - 4);
    body.content = styled(renderScan(observation, width, scanning));
    failurePanel.visible = failed();
    failureText.content = styled([renderFailurePanel(width)]);
    refreshChip.visible = scanning && observation !== null;
    palette.update({
      width: columns,
      height: rows,
      commands: [
        { id: "refresh", key: "R", label: "refresh projects", onRun: () => void refresh() },
        { id: "up", key: "K", label: "scroll up", onRun: () => scrollBy(-2) },
        { id: "down", key: "J", label: "scroll down", onRun: () => scrollBy(2) },
        { id: "top", key: "G", label: "jump to top", onRun: () => scrollTo(0) },
        {
          id: "bottom",
          key: "⇧G",
          label: "jump to bottom",
          onRun: () => scrollTo(Number.MAX_SAFE_INTEGER),
        },
        { id: "quit", key: "Q", label: "quit", onRun: shutdown },
      ],
    });
    renderer.requestRender();
  };

  const refresh = async (): Promise<void> => {
    if (scanning || closed) return;
    scanning = true;
    paint();
    const next = await scanProjects({ ...(options.root ? { root: options.root } : {}) });
    if (closed) return;
    observation = next;
    scanning = false;
    scroll.scrollTop = 0;
    paint();
  };

  renderer.keyInput.on("keypress", onKeypress);
  renderer.on("resize", paint);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);

  paint();
  void refresh();
  await finished;
}
