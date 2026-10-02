// Pure clamp/persist logic for the workbench splitter (card list <-> viewer).
// No DOM here: main.js wires events and localStorage, this module stays
// unit-testable under node --test. Viewer keeps a usable minimum, the card
// list keeps a usable minimum, and tiny containers degrade to the card min.

export const MIN_CARD_PANE_PX = 320;
export const VIEWER_MIN_PX = 420;
export const SPLITTER_STORAGE_KEY = "rfcards.splitter.width";

export function maxCardPaneWidth(containerWidth) {
  return Math.max(MIN_CARD_PANE_PX, containerWidth - VIEWER_MIN_PX);
}

export function clampSplitterWidth(width, containerWidth) {
  return Math.min(Math.max(width, MIN_CARD_PANE_PX), maxCardPaneWidth(containerWidth));
}

export function parseStoredWidth(raw, containerWidth) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return clampSplitterWidth(value, containerWidth);
}
