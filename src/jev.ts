/**
 * Thin client for TypeSafe's System One endpoint
 * (https://api.typesafe.ai/v1/systemone). Raw fetch, no SDK: the request is one
 * POST and the response is a small typed map, so the dependency would not pay
 * for itself.
 *
 * Everything here fails as `JevUnavailable`. The caller treats that as "skip
 * this prompt", never as "block the prompt".
 */
import type { Question } from "./checklist.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";
const TIMEOUT_MS = 2500;

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number; levels: number };

export class JevUnavailable extends Error {}

export interface AskOptions {
  signal?: AbortSignal | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Ask jev `questions` about `state` and return one validated answer per
 * question id. Throws `JevUnavailable` on any missing key, timeout, non-2xx
 * status, or malformed body.
 */
export async function askJev(
  state: unknown,
  questions: Record<string, Question>,
  options: AskOptions = {},
): Promise<Record<string, Answer>> {
  const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new JevUnavailable("TYPESAFE_API_KEY is not set");

  const model = options.model ?? process.env.TYPESAFE_MODEL ?? DEFAULT_MODEL;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ state, model, questions }),
      signal,
      redirect: "manual",
    });
  } catch (error) {
    throw new JevUnavailable(`request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) throw new JevUnavailable(`TypeSafe returned ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new JevUnavailable("response was not JSON");
  }

  return parseAnswers(body, Object.keys(questions));
}

/** Validate the response body against the questions we asked. */
export function parseAnswers(body: unknown, expected: readonly string[]): Record<string, Answer> {
  const answers = isRecord(body) ? body["answers"] : undefined;
  if (!isRecord(answers)) throw new JevUnavailable("response had no answers object");

  const parsed: Record<string, Answer> = {};
  for (const id of expected) {
    const raw = answers[id];
    if (raw === undefined) throw new JevUnavailable(`response was missing answer "${id}"`);
    parsed[id] = parseAnswer(id, raw);
  }
  return parsed;
}

function parseAnswer(id: string, raw: unknown): Answer {
  if (!isRecord(raw)) throw new JevUnavailable(`answer "${id}" was not an object`);
  const type = raw["type"];

  if (type === "noul") {
    const noul = finite(raw["noul"]);
    if (noul === undefined) throw new JevUnavailable(`answer "${id}" had no noul value`);
    return { type: "noul", noul };
  }

  if (type === "choice") {
    const confidence = finite(raw["confidence"]);
    const choice = raw["choice"];
    if (typeof choice !== "string" || confidence === undefined) {
      throw new JevUnavailable(`answer "${id}" was not a usable choice`);
    }
    return { type: "choice", choice, confidence };
  }

  if (type === "score") {
    const score = finite(raw["score"]);
    const confidence = finite(raw["confidence"]);
    const legend = raw["legend"];
    if (score === undefined || confidence === undefined || !isRecord(legend)) {
      throw new JevUnavailable(`answer "${id}" was not a usable score`);
    }
    const levels = Object.keys(legend).length;
    if (levels < 2) throw new JevUnavailable(`answer "${id}" had fewer than two levels`);
    return { type: "score", score, confidence, levels };
  }

  throw new JevUnavailable(`answer "${id}" had unknown type ${JSON.stringify(type)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
