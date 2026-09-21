/**
 * Turn jev's answers into a verdict. Pure functions: no network, no pi, no I/O,
 * so the whole judgment is testable from a fixture.
 *
 * Scope is deliberately narrow: the score reports confirmed gaps, and nothing
 * else. Judging a half-written prompt on style as well as content double-counts
 * the same weakness, which is how a prompt ends up at 0/100 while the user is
 * still typing it.
 */
import {
  FALLBACK_ITEMS,
  ITEMS,
  REQUIRED,
  TYPE_LABELS,
  type InputType,
} from "./checklist.ts";
import type { Answer } from "./jev.ts";

/**
 * At or below this Noul value the item counts as a confirmed gap.
 *
 * A Noul answer carries no confidence field — the probability is the whole
 * signal — so the gate is its distance from the 0.5 midpoint. An answer near
 * 0.5 means jev is undecided, and this threshold is what keeps an undecided
 * item out of the gap list.
 */
export const GAP_MAX = 0.2;

/** A prompt missing every item its type expects still scores this much. */
export const FLOOR = 20;

/**
 * Below this, the input-type Choice is too uncertain to pick a checklist from,
 * so `assess()` falls back to the universal items.
 */
export const MIN_TYPE_CONFIDENCE = 0.4;

export interface MissingItem {
  id: string;
  label: string;
  hint: string;
}

export interface Assessment {
  inputType: InputType | null;
  typeConfidence: number;
  score: number;
  grade: "A" | "B" | "C" | "D";
  missing: MissingItem[];
}

export function assess(answers: Record<string, Answer>): Assessment {
  const { inputType, typeConfidence } = classify(answers["input_type"]);
  const required = inputType ? REQUIRED[inputType] : FALLBACK_ITEMS;

  const missing: MissingItem[] = [];
  for (const id of required) {
    const item = ITEMS[id];
    if (!item) continue;
    // An absent answer is no evidence of a gap, so it counts as present rather
    // than inventing a hint.
    const answer = answers[`has_${id}`];
    const probability = answer?.type === "noul" ? answer.noul : 1;
    if (probability <= GAP_MAX) missing.push({ id, label: item.label, hint: item.hint });
  }

  // Deduct from 100, spread evenly over the items this type expects. Every type
  // then lands on FLOOR when it misses all of them, so the number means the
  // same thing whatever the checklist length.
  const perGap = required.length === 0 ? 0 : (100 - FLOOR) / required.length;
  const score = Math.round(100 - missing.length * perGap);

  return { inputType, typeConfidence, score, grade: gradeOf(score), missing };
}

function classify(answer: Answer | undefined): { inputType: InputType | null; typeConfidence: number } {
  if (answer?.type !== "choice" || answer.confidence < MIN_TYPE_CONFIDENCE) {
    return { inputType: null, typeConfidence: answer?.type === "choice" ? answer.confidence : 0 };
  }
  if (!(answer.choice in REQUIRED)) return { inputType: null, typeConfidence: answer.confidence };
  return { inputType: answer.choice as InputType, typeConfidence: answer.confidence };
}

function gradeOf(score: number): Assessment["grade"] {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

/**
 * The one-line verdict for the persistent footer status.
 *
 * Kept separate from the message sent to the model: the footer has a single
 * line, so it carries the score and the gap labels and drops the explanations.
 */
export interface StatusSummary {
  text: string;
  level: "success" | "warning" | "error";
}

export function statusSummary(assessment: Assessment): StatusSummary {
  const type = assessment.inputType ? TYPE_LABELS[assessment.inputType] : "種別不明";
  const head = `${type} ${assessment.score}/100 ${assessment.grade}`;
  if (assessment.missing.length === 0) return { text: `${head} · 不足なし`, level: "success" };
  const labels = assessment.missing.map((item) => item.label).join(", ");
  return {
    text: `${head} · 不足${assessment.missing.length}: ${labels}`,
    level: assessment.grade === "D" ? "error" : "warning",
  };
}

/**
 * The message handed to the model, invisible to the user (`display: false`).
 *
 * The user reads the score in the footer; the model gets only the gaps and the
 * instruction for closing them. The checklist itself sees the latest message
 * alone, so the instruction points the model at the repository and the
 * conversation to recover anything already settled.
 *
 * House style: affirmative sentences, so every line reads as a next step.
 * ponytail: single-message scope, upgrade by adding a `conversation` field to
 * the state and re-scoring.
 */
export function renderAssessment(assessment: Assessment): string {
  const lines = ["<prompt_assessment>", `Missing (${assessment.missing.length}):`];
  for (const item of assessment.missing) {
    lines.push(`- ${item.hint}`);
  }
  lines.push(
    "",
    "Resolve each item by exploring the repository and the conversation first.",
    "When an item stays open, present the candidate options and ask the user to choose.",
    "Interview relentlessly until you reach a shared understanding, mapping decisions as a design tree: every decision branches into the decisions that hang off it.",
    "</prompt_assessment>",
  );
  return lines.join("\n");
}
