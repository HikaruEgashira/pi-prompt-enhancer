/**
 * pi-prompt-enhancer — rate every submitted prompt with TypeSafe's jev decision
 * model and hand back the gaps as hints.
 *
 * Hooks `before_agent_start`, which fires after the user submits a prompt and
 * before the agent loop. The returned custom message is both rendered for the
 * user and sent to the model, so the model can ask for what is missing instead
 * of guessing at it.
 *
 * Fail-open by design: no API key, a timeout, or a bad response just means this
 * prompt goes through untouched.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assess, renderAssessment } from "../src/assess.ts";
import { buildQuestions } from "../src/checklist.ts";
import { askJev } from "../src/jev.ts";

/** Below this many characters the prompt is "yes", "続けて" — nothing to rate. */
const MIN_PROMPT_LENGTH = 12;

const NOTICE_TYPE = "prompt-enhancer";

export default function promptEnhancer(pi: ExtensionAPI) {
  let warned = false;

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = event.prompt?.trim() ?? "";
    if (prompt.length < MIN_PROMPT_LENGTH || prompt.startsWith("/")) return;

    if (!process.env.TYPESAFE_API_KEY) {
      if (!warned) {
        warned = true;
        ctx.ui.notify(
          "prompt-enhancer: TYPESAFE_API_KEY が未設定のため評価をスキップします",
          "warning",
        );
      }
      return;
    }

    try {
      const answers = await askJev({ request: prompt }, buildQuestions(), { signal: ctx.signal });
      const assessment = assess(answers);
      if (assessment.missing.length === 0) return;

      return {
        message: {
          customType: NOTICE_TYPE,
          content: renderAssessment(assessment),
          display: true,
        },
      };
    } catch (error) {
      if (!warned) {
        warned = true;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`prompt-enhancer: jev を呼べなかったため評価をスキップします (${reason})`, "warning");
      }
      return;
    }
  });
}
