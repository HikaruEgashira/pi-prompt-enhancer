/**
 * pi-prompt-enhancer — rate every submitted prompt with TypeSafe's jev decision
 * model and report the gaps.
 *
 * Two surfaces, split by audience:
 *  - `ctx.ui.setStatus()` puts the verdict in the persistent footer, which is
 *    where the user reads it. The prompt itself is never modified.
 *  - `before_agent_start` hands the same verdict to the model as an invisible
 *    message (`display: false`), so the model can ask for what is missing
 *    instead of guessing, without the text landing in the transcript.
 *
 * Evaluation happens in `input`, so it runs per submitted input rather than
 * once per turn. Fail-open by design: no API key, a timeout, or a bad response
 * leaves the prompt untouched and says why in the footer.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assess, renderAssessment, statusSummary } from "../src/assess.ts";
import type { Assessment } from "../src/assess.ts";
import { buildQuestions } from "../src/checklist.ts";
import { askJev } from "../src/jev.ts";

const STATUS_KEY = "prompt-enhancer";
const NOTICE_TYPE = "prompt-enhancer";

export default function promptEnhancer(pi: ExtensionAPI) {
  /** Verdict waiting to be handed to the model on the turn it belongs to. */
  let pending: Assessment | null = null;

  pi.on("input", async (event, ctx) => {
    // Never let a previous prompt's verdict reach the next turn.
    pending = null;

    // Skip our own injections, another extension's, and slash commands — the
    // latter are expanded after this hook and must not be disturbed.
    if (event.source === "extension") return;
    if (event.text.startsWith("/")) return;

    // A mid-stream correction has to reach the model immediately, and jev costs
    // 250-650ms. Flip this to `false` to rate steering messages as well.
    const skipSteering = event.streamingBehavior === "steer";
    if (skipSteering) return;

    // No length heuristic: character count is not a proxy for "worth rating"
    // across scripts, and a floor silently drops real prompts ("いい感じにして"
    // is 7 characters). The `chitchat` class is the correct gate — it has no
    // required items, so a greeting reports no gaps.
    const prompt = event.text.trim();
    if (prompt.length === 0) return;

    const { theme } = ctx.ui;

    if (!process.env.TYPESAFE_API_KEY) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("warning", "π TYPESAFE_API_KEY 未設定"));
      return;
    }

    try {
      const answers = await askJev({ request: prompt }, buildQuestions(), { signal: ctx.signal });
      const assessment = assess(answers);
      pending = assessment;
      const summary = statusSummary(assessment);
      ctx.ui.setStatus(STATUS_KEY, theme.fg(summary.level, `π ${summary.text}`));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.setStatus(STATUS_KEY, theme.fg("error", `π jev 失敗: ${reason}`));
    }
  });

  pi.on("before_agent_start", async () => {
    if (!pending) return;
    const content = renderAssessment(pending);
    pending = null;
    return { message: { customType: NOTICE_TYPE, content, display: false } };
  });
}
