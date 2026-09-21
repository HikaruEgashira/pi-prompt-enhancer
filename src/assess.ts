/**
 * Turn jev's answers into a verdict. Pure functions: no network, no pi, no I/O,
 * so the whole judgment is testable from a fixture.
 *
 * The split follows TypeSafe's composite-scoring pattern: jev supplies the
 * probabilities, this file owns the thresholds and the weights.
 */
import {
  FALLBACK_ITEMS,
  ITEMS,
  REQUIRED,
  TYPE_LABELS,
  type InputType,
} from "./checklist.ts";
import type { Answer } from "./jev.ts";

/** Below this Noul value the item counts as missing (0.5 = jev is undecided). */
export const MISSING_THRESHOLD = 0.5;

/**
 * Below this, the input-type Choice is too uncertain to pick a checklist from,
 * so `assess()` falls back to the universal items.
 */
export const MIN_TYPE_CONFIDENCE = 0.4;

const WEIGHTS = { coverage: 0.4, clarity: 0.3, specificity: 0.3 } as const;

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
  coverage: number;
  missing: MissingItem[];
}

export function assess(answers: Record<string, Answer>): Assessment {
  const { inputType, typeConfidence } = classify(answers["input_type"]);
  const required = inputType ? REQUIRED[inputType] : FALLBACK_ITEMS;

  const missing: MissingItem[] = [];
  let present = 0;
  for (const id of required) {
    const item = ITEMS[id];
    if (!item) continue;
    // An absent answer is not evidence of a gap, so treat it as present rather
    // than inventing a hint.
    const answer = answers[`has_${id}`];
    const probability = answer?.type === "noul" ? answer.noul : 1;
    if (probability >= MISSING_THRESHOLD) present += 1;
    else missing.push({ id, label: item.label, hint: item.hint });
  }

  const coverage = required.length === 0 ? 1 : present / required.length;
  const clarity = normalizeScore(answers["clarity"]);
  const specificity = normalizeScore(answers["specificity"]);
  const score = Math.round(
    100 * (WEIGHTS.coverage * coverage + WEIGHTS.clarity * clarity + WEIGHTS.specificity * specificity),
  );

  return { inputType, typeConfidence, score, grade: gradeOf(score), coverage, missing };
}

function classify(answer: Answer | undefined): { inputType: InputType | null; typeConfidence: number } {
  if (answer?.type !== "choice" || answer.confidence < MIN_TYPE_CONFIDENCE) {
    return { inputType: null, typeConfidence: answer?.type === "choice" ? answer.confidence : 0 };
  }
  if (!(answer.choice in REQUIRED)) return { inputType: null, typeConfidence: answer.confidence };
  return { inputType: answer.choice as InputType, typeConfidence: answer.confidence };
}

/** A Score answer normalised to 0..1 via its top level, per TypeSafe's guidance. */
function normalizeScore(answer: Answer | undefined): number {
  if (answer?.type !== "score") return 0.5;
  const top = Math.max(1, answer.levels - 1);
  return Math.min(1, Math.max(0, answer.score / top));
}

function gradeOf(score: number): Assessment["grade"] {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

/**
 * The single message that is both shown to the user and sent to the model, so
 * the model can ask for what is missing instead of guessing.
 *
 * The trailing note exists because the checklist sees the latest message alone:
 * anything the conversation already supplied must not be re-litigated. Lifting
 * that ceiling means passing prior turns as structured state.
 * ponytail: single-message scope, upgrade by adding a `conversation` field to
 * the state and re-scoring.
 */
export function renderAssessment(assessment: Assessment): string {
  const type = assessment.inputType ? TYPE_LABELS[assessment.inputType] : "種別不明";
  const confidence = assessment.inputType ? ` / confidence ${assessment.typeConfidence.toFixed(2)}` : "";
  const lines = [
    `プロンプト評価: ${type}${confidence} — ${assessment.score}/100 (${assessment.grade})`,
    "",
    `不足している項目 (${assessment.missing.length}):`,
  ];
  for (const item of assessment.missing) {
    lines.push(`- ${item.label}: ${item.hint}`);
  }
  lines.push(
    "",
    "※ 直近の1メッセージだけを評価しています。会話ですでに共有済みの項目は不足に数えないでください。",
  );
  return lines.join("\n");
}
