// Keep keyboard navigation in the same live control across synchronous redraws.
// Keys identify an action and its post, never an index in a changing list.
export function preserveLiveFocus(container, draw, fallback) {
  const document = container.ownerDocument, previous = document.activeElement;
  const key = container.contains(previous) ? previous?.dataset?.focusKey : null;
  const result = draw();
  if (!key || previous.isConnected) return result;
  // A redraw may intentionally open a dialog. Do not steal its focus back.
  const current = document.activeElement;
  if (current && current !== document.body && current !== previous && current.isConnected) return result;
  const replacement = [...container.querySelectorAll('[data-focus-key]')]
    .find(node => node.dataset.focusKey === key && !node.disabled);
  (replacement || fallback)?.focus({ preventScroll: true });
  return result;
}

export function captureLiveOpener(containers) {
  for (const container of containers) {
    const active = container.ownerDocument.activeElement;
    if (container.contains(active) && active?.dataset?.focusKey) return { container, key: active.dataset.focusKey };
  }
  return null;
}

export function restoreLiveOpener(opener, fallbacks) {
  if (!opener) return;
  const document = opener.container.ownerDocument;
  if (document.querySelector('dialog[open]')) return;
  const visible = node => node?.isConnected && !node.disabled && node.getClientRects().length > 0;
  const active = document.activeElement;
  if (active !== document.body && visible(active)) return;
  const replacement = [...opener.container.querySelectorAll('[data-focus-key]')]
    .find(node => node.dataset.focusKey === opener.key && visible(node));
  (replacement || fallbacks.find(visible))?.focus({ preventScroll: true });
}
