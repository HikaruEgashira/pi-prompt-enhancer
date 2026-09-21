/**
 * pi-prompt-enhancer — rate every submitted prompt with TypeSafe's jev decision
 * model and append the gaps to the prompt as hints.
 *
 * Hooks `input`, which fires before skill/template expansion and before the
 * agent starts. Transforming there means the checklist rides inside the user's
 * own turn: the user sees it in the transcript, and the model reads it as part
 * of the request rather than as detached commentary.
 *
 * Fail-open by design: no API key, a timeout, or a bad response just means the
 * prompt goes through untouched.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assess, renderAssessment } from "../src/assess.ts";
import { buildQuestions } from "../src/checklist.ts";
import { askJev } from "../src/jev.ts";

/** Below this many characters the prompt is "続けて" / "yes" — nothing to rate. */
const MIN_PROMPT_LENGTH = 12;

export default function promptEnhancer(pi: ExtensionAPI) {
  let warned = false;

  const warnOnce = (ctx: ExtensionContext, message: string) => {
    if (warned) return;
    warned = true;
    ctx.ui.notify(message, "warning");
  };

  pi.on("input", async (event, ctx) => {
    // Never rate our own injections, another extension's, or the expanded form
    // of a command. Appending to a slash command would break its expansion.
    if (event.source === "extension") return;
    if (event.text.startsWith("/")) return;

    // A mid-stream correction has to reach the model immediately, and jev costs
    // 250-650ms. Flip this to `false` to rate steering messages as well.
    const skipSteering = event.streamingBehavior === "steer";
    if (skipSteering) return;

    const prompt = event.text.trim();
    if (prompt.length < MIN_PROMPT_LENGTH) return;

    if (!process.env.TYPESAFE_API_KEY) {
      warnOnce(ctx, "prompt-enhancer: TYPESAFE_API_KEY が未設定のため評価をスキップします");
      return;
    }

    try {
      const answers = await askJev({ request: prompt }, buildQuestions(), { signal: ctx.signal });
      const assessment = assess(answers);
      if (assessment.missing.length === 0) return;

      return {
        action: "transform",
        text: `${event.text}\n\n${renderAssessment(assessment)}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnOnce(ctx, `prompt-enhancer: jev を呼べなかったため評価をスキップします (${reason})`);
      return;
    }
  });
}
