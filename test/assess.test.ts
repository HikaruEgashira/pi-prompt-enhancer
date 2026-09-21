import assert from "node:assert/strict";
import test from "node:test";
import { assess, renderAssessment, statusSummary, FLOOR, GAP_MAX } from "../src/assess.ts";
import { ITEMS, REQUIRED, buildQuestions } from "../src/checklist.ts";
import { JevUnavailable, parseAnswers, type Answer } from "../src/jev.ts";

const noul = (value: number): Answer => ({ type: "noul", noul: value });
const type = (choice: string, confidence = 0.9): Answer => ({ type: "choice", choice, confidence });

function answers(overrides: Record<string, Answer>): Record<string, Answer> {
  return { input_type: type("task"), ...overrides };
}

test("only confirmed gaps count, so an undecided item stays off the list", () => {
  const result = assess(
    answers({
      has_goal: noul(0.94),
      has_context: noul(0.45), // jev is undecided: keep it out of the gap list
      has_constraints: noul(0.08),
      has_output_format: noul(GAP_MAX),
      has_success_criteria: noul(0.31),
    }),
  );

  assert.deepEqual(
    result.missing.map((item) => item.label),
    ["制約", "出力形式"],
  );
  // Two gaps of a five item checklist: 100 - 2 * 16.
  assert.equal(result.score, 68);
  assert.equal(result.grade, "B");
});

test("a mid-range answer is treated as present", () => {
  const result = assess(
    answers({
      has_goal: noul(0.5),
      has_context: noul(GAP_MAX + 0.01),
      has_constraints: noul(1),
      has_output_format: noul(1),
      has_success_criteria: noul(1),
    }),
  );
  assert.deepEqual(result.missing, []);
  assert.equal(result.score, 100);
});

test("a prompt that misses every item lands on FLOOR for its type", () => {
  for (const [inputType, items] of Object.entries(REQUIRED)) {
    if (items.length === 0) continue;
    const allMissing = Object.fromEntries(items.map((id) => [`has_${id}`, noul(0)]));
    const result = assess(answers({ input_type: type(inputType, 1), ...allMissing }));
    assert.equal(result.missing.length, items.length, inputType);
    assert.equal(result.score, FLOOR, inputType);
  }
});

test("chitchat has nothing to report and cannot be penalised", () => {
  const result = assess(answers({ input_type: type("chitchat", 0.97) }));

  assert.deepEqual(result.missing, []);
  assert.equal(result.inputType, "chitchat");
  assert.equal(result.score, 100);
});

test("an uncertain input type falls back to the universal items", () => {
  const result = assess(answers({ input_type: type("creative", 0.21), has_goal: noul(0.9), has_context: noul(0.1) }));

  assert.equal(result.inputType, null);
  assert.equal(result.typeConfidence, 0.21);
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ["context"],
  );
  // Two universal items: 100 - 1 * 40.
  assert.equal(result.score, 60);
  // creative-only items are out of scope in the fallback, so audience stays away.
  assert.equal(
    result.missing.some((item) => item.id === "audience"),
    false,
  );
});

test("an option outside the taxonomy falls back instead of guessing", () => {
  const result = assess(answers({ input_type: type("smalltalk", 0.99), has_goal: noul(0.95), has_context: noul(0.95) }));

  assert.equal(result.inputType, null);
  assert.equal(result.score, 100);
});

test("an absent answer counts as present", () => {
  const result = assess(answers({}));
  assert.deepEqual(result.missing, []);
  assert.equal(result.score, 100);
});

test("the model block is exactly the gaps plus the instruction", () => {
  const result = assess(
    answers({
      has_goal: noul(0.9),
      has_context: noul(0.9),
      has_constraints: noul(0.0),
      has_output_format: noul(0.1),
      has_success_criteria: noul(0.1),
    }),
  );

  // Pinned in full: this text is the contract the agent reads. It carries the
  // gaps and one instruction per line, with the score kept for the footer.
  assert.equal(
    renderAssessment(result),
    [
      "<prompt_assessment>",
      "Missing (3):",
      "- State the constraints: language, dependencies, scope, deadline, off-limits areas.",
      "- Specify the output format, structure, and length (prose, bullets, table, code, size cap).",
      "- State how the result gets judged or verified (tests, acceptance criteria).",
      "",
      "Resolve each item by exploring the repository and the conversation first.",
      "When an item stays open, present the candidate options and ask the user to choose.",
      "Interview relentlessly until you reach a shared understanding, mapping decisions as a design tree: every decision branches into the decisions that hang off it.",
      "</prompt_assessment>",
    ].join("\n"),
  );
});

test("every checklist item gets a question, and no question scores style", () => {
  const questions = buildQuestions();
  for (const id of Object.keys(ITEMS)) {
    assert.ok(`has_${id}` in questions, `missing question has_${id}`);
  }
  assert.ok("input_type" in questions);
  assert.equal("clarity" in questions, false);
  assert.equal("specificity" in questions, false);
});

test("statusSummary carries the gaps in one line and escalates on a D", () => {
  const few = assess(
    answers({
      has_goal: noul(0.9),
      has_context: noul(0.9),
      has_constraints: noul(0.0),
      has_output_format: noul(0.1),
      has_success_criteria: noul(0.1),
    }),
  );
  assert.equal(statusSummary(few).text, "タスク依頼 52/100 C · 不足3: 制約, 出力形式, 完了条件");
  assert.equal(statusSummary(few).level, "warning");

  const worst = assess(
    answers({
      has_goal: noul(0),
      has_context: noul(0),
      has_constraints: noul(0),
      has_output_format: noul(0),
      has_success_criteria: noul(0),
    }),
  );
  assert.equal(worst.score, FLOOR);
  assert.equal(statusSummary(worst).level, "error");

  const clean = assess(
    answers({
      has_goal: noul(0.9),
      has_context: noul(0.9),
      has_constraints: noul(0.9),
      has_output_format: noul(0.9),
      has_success_criteria: noul(0.9),
    }),
  );
  assert.equal(statusSummary(clean).text, "タスク依頼 100/100 A · 不足なし");
  assert.equal(statusSummary(clean).level, "success");
});

test("parseAnswers validates shape and rejects a malformed answer", () => {
  const valid = parseAnswers(
    {
      answers: {
        has_goal: { type: "noul", noul: 0.8 },
        input_type: { type: "choice", choice: "task", confidence: 0.9 },
      },
    },
    ["has_goal", "input_type"],
  );
  assert.deepEqual(valid["has_goal"], { type: "noul", noul: 0.8 });
  assert.deepEqual(valid["input_type"], { type: "choice", choice: "task", confidence: 0.9 });

  assert.throws(() => parseAnswers({ answers: {} }, ["has_goal"]), JevUnavailable);
  assert.throws(() => parseAnswers({ answers: { has_goal: { type: "noul", noul: "0.8" } } }, ["has_goal"]), JevUnavailable);
  assert.throws(() => parseAnswers({ answers: { has_goal: { type: "score", score: 1 } } }, ["has_goal"]), JevUnavailable);
  assert.throws(() => parseAnswers({}, ["has_goal"]), JevUnavailable);
});
