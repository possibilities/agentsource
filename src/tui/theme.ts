/**
 * Signal Room: the shared arthack instrument-panel palette. The canonical
 * tokens live in the operator wiki; every fleet app owns its local copy.
 */
export const SIGNAL_ROOM = {
  canvas: "#090c0e",
  field: "#0d1215",
  panel: "#131a1e",
  line: "#2a343a",
  text: "#d8e2e7",
  muted: "#7d8a91",
  faint: "#4b575e",
  accent: "#67d7c9",
  local: "#e2b56f",
  remote: "#7fb9e8",
  ok: "#82cb9a",
  hot: "#e6965b",
  danger: "#ee7e89",
} as const;

export type TokenName = keyof typeof SIGNAL_ROOM;

export const GLYPHS = {
  rail: "▎",
  live: "●",
  idle: "○",
  rule: "─",
  refresh: "↻",
  separator: "·",
  ellipsis: "…",
} as const;
