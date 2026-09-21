/**
 * pi-prompt-enhancer — rate a prompt with TypeSafe's jev decision model and
 * report the gaps in the persistent footer status.
 *
 * Evaluation runs *before* the prompt is submitted, so the score is visible
 * while typing, and it runs again on submit to hand the model the final
 * verdict. pi exposes no editor-change event, so the editor is polled and
 * `src/watch.ts` decides when the text has been quiet long enough to be worth
 * a request.
 *
 * The user reads the footer. The model gets the same verdict as an invisible
 * message (`display: false`), so the prompt itself is never modified.
 *
 * Fail-open by design: no API key, a timeout, or a bad response leaves the
 * prompt untouched and says why in the footer.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assess, renderAssessment, statusSummary } from "../src/assess.ts";
import type { Assessment } from "../src/assess.ts";
import { buildQuestions } from "../src/checklist.ts";
import { askJev } from "../src/jev.ts";
import { decideEditor, initialWatchState, type WatchState } from "../src/watch.ts";

const STATUS_KEY = "prompt-enhancer";
const NOTICE_TYPE = "prompt-enhancer";

/** How often the editor is inspected. Reading a string is free. */
const POLL_MS = 350;
/** The editor must be quiet this long before jev is asked again. */
const QUIET_MS = 700;

export default function promptEnhancer(pi: ExtensionAPI) {
  /** Verdict waiting to be handed to the model on the turn it belongs to. */
  let pending: Assessment | null = null;
  /** Last computed verdict, so submitting reuses it instead of paying twice. */
  let cached: { text: string; assessment: Assessment } | null = null;
  /** Request in flight, keyed by text, so poll and submit never duplicate one. */
  let inflight: { text: string; promise: Promise<Assessment | null> } | null = null;

  let watch: WatchState = { ...initialWatchState };
  let noKeyReported = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const reportMissingKey = (ctx: ExtensionContext): boolean => {
    if (process.env.TYPESAFE_API_KEY) return false;
    if (!noKeyReported) {
      noKeyReported = true;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", "π TYPESAFE_API_KEY 未設定"));
    }
    return true;
  };

  const run = (text: string, ctx: ExtensionContext): Promise<Assessment | null> => {
    if (cached?.text === text) return Promise.resolve(cached.assessment);
    if (inflight?.text === text) return inflight.promise;

    const promise = (async (): Promise<Assessment | null> => {
      try {
        const answers = await askJev({ request: text }, buildQuestions(), { signal: ctx.signal });
        const assessment = assess(answers);
        cached = { text, assessment };
        const summary = statusSummary(assessment);
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(summary.level, `π ${summary.text}`));
        return assessment;
      } catch (error) {
        // Drop the cache so a later attempt is allowed, but never retry-storm:
        // the watcher records the text as evaluated either way.
        cached = null;
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("error", `π jev 失敗: ${reason}`));
        return null;
      }
    })();

    inflight = { text, promise };
    void promise.finally(() => {
      if (inflight?.text === text) inflight = null;
    });
    return promise;
  };

  const poll = async (ctx: ExtensionContext) => {
    if (inflight) return;
    if (reportMissingKey(ctx)) return;
    // While the agent runs the editor holds a steering message; rating it would
    // add 250-650ms to a correction that has to be immediate.
    if (!ctx.isIdle()) return;

    let text: string;
    try {
      text = ctx.ui.getEditorText().trim();
    } catch {
      return;
    }

    const { decision, state } = decideEditor(watch, text, Date.now(), QUIET_MS);
    // Record the attempt before awaiting so a failure cannot retry every tick.
    watch = decision === "evaluate" ? { ...state, evaluated: text } : state;
    if (decision === "evaluate") await run(text, ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    cached = null;
    inflight = null;
    watch = { ...initialWatchState };
    noKeyReported = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    // The editor only exists in the interactive TUI.
    if (ctx.mode !== "tui") return;
    timer = setInterval(() => {
      void poll(ctx);
    }, POLL_MS);
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  pi.on("input", async (event, ctx) => {
    // Never let a previous prompt's verdict reach the next turn.
    pending = null;

    if (event.source === "extension") return;
    if (event.text.startsWith("/")) return;
    if (event.streamingBehavior === "steer") return;

    const text = event.text.trim();
    if (text.length === 0) return;
    if (reportMissingKey(ctx)) return;

    const assessment = await run(text, ctx);
    // A prompt with no gaps gets no message: an empty checklist would still
    // invite the model to interview the user about nothing.
    pending = assessment && assessment.missing.length > 0 ? assessment : null;
  });

  pi.on("before_agent_start", async () => {
    if (!pending) return;
    const content = renderAssessment(pending);
    pending = null;
    return { message: { customType: NOTICE_TYPE, content, display: false } };
  });
}
