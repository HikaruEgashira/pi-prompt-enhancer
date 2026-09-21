import assert from "node:assert/strict";
import test from "node:test";
import { decideEditor, initialWatchState } from "../src/watch.ts";

const QUIET = 700;

test("the first sighting never fires; it only starts the quiet window", () => {
  const first = decideEditor(initialWatchState, "いい感じにして", 1000, QUIET);
  assert.equal(first.decision, "wait");
  assert.deepEqual(first.state, { seen: "いい感じにして", seenAt: 1000, evaluated: "" });
});

test("typing keeps resetting the window, and a pause fires exactly once", () => {
  let state = decideEditor(initialWatchState, "い", 0, QUIET).state;

  // Still typing: each change moves seenAt forward.
  for (const [text, now] of [["いい", 200], ["いい感", 400], ["いい感じ", 600]] as const) {
    const step = decideEditor(state, text, now, QUIET);
    assert.equal(step.decision, "wait", `${text} should not fire`);
    state = step.state;
  }

  // Quiet for less than the window: still waiting.
  assert.equal(decideEditor(state, "いい感じ", 1000, QUIET).decision, "wait");
  assert.equal(decideEditor(state, "いい感じ", 1299, QUIET).decision, "wait");
  // Quiet long enough.
  assert.equal(decideEditor(state, "いい感じ", 1300, QUIET).decision, "evaluate");
});

test("the same text is never evaluated twice", () => {
  const evaluated = { seen: "いい感じ", seenAt: 0, evaluated: "いい感じ" };
  assert.equal(decideEditor(evaluated, "いい感じ", 10_000, QUIET).decision, "skip");
});

test("empty input and slash commands are skipped, but do not clear the verdict", () => {
  assert.equal(decideEditor(initialWatchState, "", 0, QUIET).decision, "skip");
  const slash = { seen: "/model", seenAt: 0, evaluated: "" };
  assert.equal(decideEditor(slash, "/model", 10_000, QUIET).decision, "skip");
});

test("an edit after an evaluation reopens the window", () => {
  const evaluated = { seen: "いい感じ", seenAt: 0, evaluated: "いい感じ" };
  const edited = decideEditor(evaluated, "いい感じにして", 5000, QUIET);
  assert.equal(edited.decision, "wait");
  assert.deepEqual(edited.state, { seen: "いい感じにして", seenAt: 5000, evaluated: "いい感じ" });
  assert.equal(decideEditor(edited.state, "いい感じにして", 5700, QUIET).decision, "evaluate");
});
