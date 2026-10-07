export const FLOOD_LIMIT = 10;
export const FLOOD_WINDOW_MS = 10 * 60_000;

/** True when this search already had FLOOD_LIMIT alerts sent inside the window. */
export function shouldHold(recentSentAt: number[], now: number): boolean {
  return recentSentAt.filter((sentAt) => sentAt > now - FLOOD_WINDOW_MS).length >= FLOOD_LIMIT;
}

/** Send held alerts as one digest once the flood has passed, or after one window at most. */
export function digestDue(recentSentAt: number[], heldCreatedAt: number[], now: number): boolean {
  if (heldCreatedAt.length === 0) return false;
  return !shouldHold(recentSentAt, now) || Math.min(...heldCreatedAt) <= now - FLOOD_WINDOW_MS;
}
