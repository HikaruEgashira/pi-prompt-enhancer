/**
 * Debounce for the editor poller.
 *
 * pi exposes no editor-change event, so the editor has to be polled. Polling a
 * string is free; the decision model is not (250-650ms and a request each
 * time). `decideEditor` is the whole policy in one pure function: fire only
 * once the text has been quiet for `quietMs`, and never twice for the same text.
 */
export interface WatchState {
  /** Editor text observed at the previous poll. */
  seen: string;
  /** When `seen` last changed. */
  seenAt: number;
  /** Text of the most recent evaluation attempt, successful or not. */
  evaluated: string;
}

export const initialWatchState: WatchState = { seen: "", seenAt: 0, evaluated: "" };

export type EditorDecision =
  /** Still typing (or the quiet window has not elapsed). */
  | "wait"
  /** Nothing worth rating: empty, or a slash command that must not be disturbed. */
  | "skip"
  /** Quiet and changed since the last attempt. */
  | "evaluate";

export function decideEditor(
  state: WatchState,
  text: string,
  now: number,
  quietMs: number,
): { decision: EditorDecision; state: WatchState } {
  if (text !== state.seen) {
    return { decision: "wait", state: { ...state, seen: text, seenAt: now } };
  }
  if (text.length === 0 || text.startsWith("/")) return { decision: "skip", state };
  if (text === state.evaluated) return { decision: "skip", state };
  if (now - state.seenAt < quietMs) return { decision: "wait", state };
  return { decision: "evaluate", state };
}
