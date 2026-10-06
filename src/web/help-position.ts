export function helpPosition(
  anchor: { left: number; top: number; bottom: number },
  popup: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const margin = 12;
  const below = anchor.bottom + 8;
  return {
    left: Math.max(
      margin,
      Math.min(anchor.left, viewport.width - popup.width - margin),
    ),
    top: Math.max(
      margin,
      below + popup.height <= viewport.height - margin
        ? below
        : anchor.top - popup.height - 8,
    ),
  };
}
