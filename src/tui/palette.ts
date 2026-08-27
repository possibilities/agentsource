type OpenTui = typeof import("@opentui/core");

export interface PaletteCommand {
  id: string;
  key: string;
  label: string;
  onRun(): void;
}

export interface PaletteState {
  commands: readonly PaletteCommand[];
  width: number;
  height: number;
}

export interface PaletteTokens {
  panel: string;
  line: string;
  accent: string;
  muted: string;
  text: string;
}

export interface CommandPalette {
  root: InstanceType<OpenTui["BoxRenderable"]>;
  isOpen(): boolean;
  close(): void;
  handleKey(key: {
    name: string;
    ctrl: boolean;
    meta?: boolean;
    sequence?: string;
    eventType?: string;
  }): boolean;
  update(state: PaletteState): void;
}

/** Case-insensitive substring filter over command label and key. */
export function paletteMatches(
  commands: readonly PaletteCommand[],
  filter: string,
): PaletteCommand[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return [...commands];
  return commands.filter((command) =>
    `${command.label} ${command.key}`.toLowerCase().includes(needle),
  );
}

const MAX_VISIBLE_ROWS = 10;

export function createCommandPalette(
  core: OpenTui,
  renderer: Awaited<ReturnType<OpenTui["createCliRenderer"]>>,
  tokens: PaletteTokens,
): CommandPalette {
  let open = false;
  let filter = "";
  let selected = 0;
  let start = 0;
  let state: PaletteState = { commands: [], width: 80, height: 24 };

  const root = new core.BoxRenderable(renderer, {
    id: "source-command-palette",
    position: "absolute",
    zIndex: 100,
    visible: false,
    flexDirection: "column",
    border: true,
    borderStyle: "single",
    borderColor: tokens.line,
    backgroundColor: tokens.panel,
    title: " COMMANDS ",
    titleColor: tokens.muted,
    titleAlignment: "left",
    paddingLeft: 2,
    paddingRight: 2,
    onMouseScroll: (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      move(direction === "down" ? 1 : -1);
      event.preventDefault();
      event.stopPropagation();
    },
  });
  const filterText = new core.TextRenderable(renderer, {
    id: "source-command-filter",
    content: "",
    height: 1,
    wrapMode: "none",
  });
  const rows = new core.BoxRenderable(renderer, {
    id: "source-command-rows",
    flexDirection: "column",
    marginTop: 1,
    backgroundColor: tokens.panel,
  });
  root.add(filterText);
  root.add(rows);

  const matches = (): PaletteCommand[] => paletteMatches(state.commands, filter);

  function move(delta: number, wrap = false): void {
    const count = matches().length;
    if (count === 0) return;
    const next = selected + delta;
    if (wrap && next < 0 && selected === 0) selected = count - 1;
    else if (wrap && next >= count && selected === count - 1) selected = 0;
    else selected = Math.max(0, Math.min(count - 1, next));
    layout();
    renderer.requestRender();
  }

  function close(): void {
    open = false;
    root.visible = false;
    renderer.requestRender();
  }

  function run(command: PaletteCommand): void {
    close();
    command.onRun();
  }

  function openPalette(): void {
    open = true;
    filter = "";
    selected = 0;
    start = 0;
    root.visible = true;
    layout();
    renderer.requestRender();
  }

  function layout(): void {
    const visible = matches();
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    const width = Math.max(1, Math.min(48, state.width - 4));
    const availableRows = Math.max(1, state.height - 4);
    const rowCount = Math.min(Math.max(1, visible.length), availableRows, MAX_VISIBLE_ROWS);
    if (selected < start) start = selected;
    if (selected >= start + rowCount) start = selected - rowCount + 1;
    start = Math.max(0, Math.min(start, Math.max(0, visible.length - rowCount)));
    const height = rowCount + 4;
    root.width = width;
    root.height = height;
    root.left = Math.max(0, Math.floor((state.width - width) / 2));
    root.top = Math.max(0, Math.floor((state.height - height) / 3));

    filterText.content = new core.StyledText([
      core.bold(core.fg(tokens.accent)("> ")),
      filter === "" ? core.fg(tokens.muted)("type to filter") : core.fg(tokens.text)(filter),
    ]);
    for (const child of rows.getChildren()) {
      rows.remove(child.id);
      child.destroyRecursively();
    }
    if (visible.length === 0) {
      rows.add(
        new core.TextRenderable(renderer, {
          content: "no matching command",
          fg: tokens.muted,
          height: 1,
        }),
      );
      return;
    }
    const window = visible.slice(start, start + rowCount);
    const keyWidth = state.commands.reduce(
      (longest, command) => Math.max(longest, command.key.length),
      1,
    );
    window.forEach((command, index) => {
      const active = start + index === selected;
      const row = new core.BoxRenderable(renderer, {
        id: `source-command-${command.id}`,
        height: 1,
        backgroundColor: tokens.panel,
        onMouseUp: (event) => {
          event.stopPropagation();
          run(command);
        },
      });
      const key = `[${command.key}]`.padEnd(keyWidth + 2);
      row.add(
        new core.TextRenderable(renderer, {
          content: new core.StyledText([
            active ? core.bold(core.fg(tokens.accent)("▎ ")) : core.fg(tokens.panel)("  "),
            core.bold(core.fg(tokens.accent)(key)),
            core.fg(active ? tokens.text : tokens.muted)(` ${command.label}`),
          ]),
        }),
      );
      rows.add(row);
    });
  }

  return {
    root,
    isOpen: () => open,
    close,
    handleKey(key) {
      if (key.ctrl && key.name === "c") return false;
      if (key.eventType === "release") return open;
      if (!open) {
        if (key.ctrl && key.name === "k") {
          openPalette();
          return true;
        }
        return false;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "k")) {
        close();
        return true;
      }
      if (key.name === "return" || key.name === "enter") {
        const command = matches()[selected];
        if (command) run(command);
        return true;
      }
      if (key.name === "up") {
        move(-1, true);
        return true;
      }
      if (key.name === "down") {
        move(1, true);
        return true;
      }
      if (key.name === "backspace") {
        filter = filter.slice(0, -1);
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
        return true;
      }
      const sequence = key.sequence ?? "";
      if (!key.ctrl && key.meta !== true && sequence.length === 1 && sequence >= " ") {
        filter += sequence;
        selected = 0;
        start = 0;
        layout();
        renderer.requestRender();
      }
      return true;
    },
    update(next) {
      state = next;
      if (open) layout();
    },
  };
}
