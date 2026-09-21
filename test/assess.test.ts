import assert from "node:assert/strict";
import test from "node:test";
import { assess, renderAssessment, statusSummary } from "../src/assess.ts";
import { ITEMS, buildQuestions } from "../src/checklist.ts";
import { JevUnavailable, parseAnswers, type Answer } from "../src/jev.ts";

const present = (noul: number): Answer => ({ type: "noul", noul });

function answers(overrides: Record<string, Answer>): Record<string, Answer> {
  return {
    input_type: { type: "choice", choice: "task", confidence: 0.9 },
    clarity: { type: "score", score: 2, confidence: 0.9, levels: 3 },
    specificity: { type: "score", score: 2, confidence: 0.9, levels: 3 },
    ...overrides,
  };
}

test("a task missing three items reports exactly those", () => {
  const result = assess(
    answers({
      has_goal: present(0.94),
      has_context: present(0.81),
      has_constraints: present(0.08),
      has_output_format: present(0.2),
      has_success_criteria: present(0.31),
    }),
  );

  assert.deepEqual(
    result.missing.map((item) => item.label),
    ["制約", "出力形式", "完了条件"],
  );
  // 2 of 5 required items present, both Scores at the top level.
  assert.equal(result.coverage, 0.4);
  assert.equal(result.score, 76);
  assert.equal(result.grade, "B");
});

test("chitchat has nothing to report and cannot be penalised", () => {
  const result = assess(
    answers({
      input_type: { type: "choice", choice: "chitchat", confidence: 0.97 },
      clarity: { type: "score", score: 1.4, confidence: 0.5, levels: 3 },
      specificity: { type: "score", score: 1.1, confidence: 0.5, levels: 3 },
    }),
  );

  assert.deepEqual(result.missing, []);
  assert.equal(result.inputType, "chitchat");
  // Coverage cannot be earned or lost, so only the Scores move the number.
  assert.equal(result.score, 78);
});

test("an uncertain input type falls back to the universal items", () => {
  const result = assess(
    answers({
      input_type: { type: "choice", choice: "creative", confidence: 0.21 },
      has_goal: present(0.9),
      has_context: present(0.1),
    }),
  );

  assert.equal(result.inputType, null);
  assert.equal(result.typeConfidence, 0.21);
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ["context"],
  );
  // creative-only items are not checked, so they must not appear as hints.
  assert.equal(
    result.missing.some((item) => item.id === "audience"),
    false,
  );
});

test("an option outside the taxonomy falls back instead of guessing", () => {
  const result = assess(
    answers({
      input_type: { type: "choice", choice: "smalltalk", confidence: 0.99 },
      has_goal: present(0.95),
      has_context: present(0.95),
    }),
  );

  assert.equal(result.inputType, null);
  assert.equal(result.score, 100);
});

test("a missing answer is treated as present, not as a gap", () => {
  const result = assess(answers({}));
  assert.deepEqual(result.missing, []);
  assert.equal(result.coverage, 1);
});

test("a Noul exactly at the threshold counts as present", () => {
  const result = assess(answers({ has_goal: present(0.5), has_context: present(0.49) }));
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ["context"],
  );
});

test("renderAssessment carries the score, the label, and the hint", () => {
  const result = assess(
    answers({
      has_goal: present(0.9),
      has_context: present(0.9),
      has_constraints: present(0.0),
      has_output_format: present(0.1),
      has_success_criteria: present(0.1),
    }),
  );
  const text = renderAssessment(result);

  assert.match(text, /タスク依頼/);
  assert.match(text, /76\/100 \(B\)/);
  assert.match(text, /- 制約: 守るべき条件/);
  // It is appended to the user's own message, so it must stay delimited.
  assert.ok(text.startsWith("<prompt_assessment>"));
  assert.ok(text.endsWith("</prompt_assessment>"));
});

test("every checklist item gets a question and every required id is a real item", () => {
  const questions = buildQuestions();
  for (const id of Object.keys(ITEMS)) {
    assert.ok(`has_${id}` in questions, `missing question has_${id}`);
  }
  assert.ok("input_type" in questions);
  assert.ok("clarity" in questions);
  assert.ok("specificity" in questions);
});

test("statusSummary carries the gaps in one line and escalates on a D", () => {
  const failing = assess(
    answers({
      has_goal: present(0.9),
      has_context: present(0.9),
      has_constraints: present(0.0),
      has_output_format: present(0.1),
      has_success_criteria: present(0.1),
    }),
  );
  assert.equal(statusSummary(failing).text, "タスク依頼 76/100 B · 不足3: 制約, 出力形式, 完了条件");
  assert.equal(statusSummary(failing).level, "warning");

  const worst = assess(
    answers({
      has_goal: present(0),
      has_context: present(0),
      has_constraints: present(0),
      has_output_format: present(0),
      has_success_criteria: present(0),
      clarity: { type: "score", score: 0, confidence: 0.9, levels: 3 },
      specificity: { type: "score", score: 0, confidence: 0.9, levels: 3 },
    }),
  );
  assert.equal(worst.score, 0);
  assert.equal(statusSummary(worst).level, "error");

  const clean = assess(
    answers({
      has_goal: present(0.9),
      has_context: present(0.9),
      has_constraints: present(0.9),
      has_output_format: present(0.9),
      has_success_criteria: present(0.9),
    }),
  );
  assert.equal(statusSummary(clean).text, "タスク依頼 100/100 A · 不足なし");
  assert.equal(statusSummary(clean).level, "success");
});

test("parseAnswers validates shape and rejects a malformed answer", () => {
  const valid = parseAnswers(
    { answers: { has_goal: { type: "noul", noul: 0.8 }, clarity: { type: "score", score: 1.5, confidence: 0.6, legend: { "0": "a", "1": "b" } } } },
    ["has_goal", "clarity"],
  );
  assert.deepEqual(valid["has_goal"], { type: "noul", noul: 0.8 });
  assert.deepEqual(valid["clarity"], { type: "score", score: 1.5, confidence: 0.6, levels: 2 });

  assert.throws(() => parseAnswers({ answers: {} }, ["has_goal"]), JevUnavailable);
  assert.throws(() => parseAnswers({ answers: { has_goal: { type: "noul", noul: "0.8" } } }, ["has_goal"]), JevUnavailable);
  assert.throws(() => parseAnswers({}, ["has_goal"]), JevUnavailable);
});
