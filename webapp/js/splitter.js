// Pure clamp/persist logic for the workbench splitter (card list <-> viewer)
// plus the stacked (mobile portrait) layout state transitions. No DOM here:
// main.js wires events, matchMedia and localStorage, this module stays
// unit-testable under node --test. Viewer keeps a usable minimum, the card
// list keeps a usable minimum, and tiny containers degrade to the card min.

export const MIN_CARD_PANE_PX = 320;
export const VIEWER_MIN_PX = 420;
export const SPLITTER_STORAGE_KEY = "rfcards.splitter.width";

// Portrait phones stack the card pane above the viewer (media query in
// css/app.css) and hide the splitter entirely.
export const STACKED_MEDIA_QUERY = "(max-width: 768px) and (orientation: portrait)";

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

// The splitter cannot be dragged while stacked (it is display:none).
export function shouldDrag(stacked) {
  return !stacked;
}

// Transition between the split and stacked layouts: toggles the body class the
// portrait CSS keys on. Entering stacked clears the inline width/flex-basis
// that drags and the resize handler leave on the card pane (inline styles
// would beat the media query). Leaving stacked re-applies the persisted split
// exactly like startup, clamped to the current container.
export function applyStackedState(stacked, { body, cardPane, storedWidth, containerWidth, applyWidth }) {
  body.classList.toggle("stacked", stacked);
  if (stacked) {
    cardPane.style.removeProperty("width");
    cardPane.style.removeProperty("flex-basis");
    return;
  }
  const px = parseStoredWidth(storedWidth, containerWidth);
  if (px !== null && applyWidth) applyWidth(px);
}
