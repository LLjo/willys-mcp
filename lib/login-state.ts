/**
 * Process-global tracking of the Willys re-authentication state.
 *
 * Why this exists:
 *  - When a Willys session expires mid-conversation, the user's first hint is
 *    a 5–15s pause while we silently re-auth via Puppeteer. Surfacing this
 *    state lets the LLM tell the user "session expired, I re-logged in, then
 *    added the milk" instead of just appearing slow.
 *  - Concurrent tool calls (e.g. "add milk and coffee" → two add_to_cart
 *    calls in quick succession) must not each spawn their own Puppeteer
 *    login — they'd race on the session row and burn ~30s of CPU. The
 *    inflight-Promise mutex below de-dupes concurrent refresh attempts.
 *
 * State machine:
 *   idle ─── action fails with auth error ──> logging_in
 *   logging_in ─── Puppeteer succeeds ───> logged_in
 *   logging_in ─── Puppeteer fails ──────> failed
 *   {logged_in,failed} ── another auth failure ──> logging_in (loop)
 *
 * Read state via `getLoginState()`. Drive state via `runLoginOnce(...)` —
 * concurrent callers share the same in-flight Promise.
 */

export type LoginStatus = "idle" | "logging_in" | "logged_in" | "failed";

export interface LoginState {
  status: LoginStatus;
  /** Free-text "what we were trying to do when we noticed the session was dead". Useful in the post-login message. */
  pendingAction: string | null;
  /** Epoch ms when the current/last logging_in transition fired. null on cold start. */
  startedAt: number | null;
  /** Epoch ms when the current/last logging_in transition completed (success or failure). null while in-flight. */
  completedAt: number | null;
  /** How long the last login took (ms). null on cold start. */
  lastDurationMs: number | null;
  /** Error string from the last `failed` transition. null if last attempt succeeded. */
  lastError: string | null;
  /** Number of successful auto-reauths in this process lifetime. */
  successCount: number;
  /** Number of failed auto-reauths in this process lifetime. */
  failureCount: number;
}

const state: LoginState = {
  status: "idle",
  pendingAction: null,
  startedAt: null,
  completedAt: null,
  lastDurationMs: null,
  lastError: null,
  successCount: 0,
  failureCount: 0,
};

let inflight: Promise<boolean> | null = null;

export function getLoginState(): LoginState {
  return { ...state };
}

/**
 * If a re-login is currently in flight, await it. No-op otherwise.
 *
 * Why: when the LLM-orchestrated reauth flow is triggered, the LLM calls
 * `mcp__willys_reauth` and then immediately retries the original action.
 * Some LLM clients (notably the local Qwen) fire the retry before the
 * reauth tool's response arrives — the action then sees stale cookies,
 * hits 401, throws another needsAuth, and we burn an extra round-trip.
 * Calling this at the top of `withAuthRefresh` makes the action wait for
 * the same in-flight login instead of running on doomed cookies.
 */
export async function awaitInflightLogin(): Promise<void> {
  if (inflight) {
    await inflight.catch(() => {});
  }
}

/**
 * Run `loginFn` exactly once across concurrent callers and bookkeep state.
 * If a refresh is already in flight, every caller awaits the same Promise
 * — they all see the same result and the post-success message can say
 * "re-logged in N ms ago" truthfully.
 *
 * `actionDescription` is recorded in `pendingAction` and exposed by
 * `getLoginState()`. Use a short human-readable phrase like
 * `"add_to_cart productCode=101232592_ST qty=1"`.
 */
export async function runLoginOnce(
  actionDescription: string,
  loginFn: () => Promise<{ success: boolean; error?: string }>,
): Promise<boolean> {
  if (inflight) {
    console.error(
      `[login-state] Already logging in for "${state.pendingAction}"; "${actionDescription}" will await the same login.`,
    );
    return inflight;
  }
  state.status = "logging_in";
  state.pendingAction = actionDescription;
  state.startedAt = Date.now();
  state.completedAt = null;
  console.error(`[login-state] logging_in for "${actionDescription}"`);

  inflight = (async () => {
    const t0 = Date.now();
    try {
      const result = await loginFn();
      const elapsed = Date.now() - t0;
      state.completedAt = Date.now();
      state.lastDurationMs = elapsed;
      if (result.success) {
        state.status = "logged_in";
        state.lastError = null;
        state.successCount += 1;
        console.error(
          `[login-state] logged_in in ${elapsed}ms (action was "${actionDescription}")`,
        );
        return true;
      }
      state.status = "failed";
      state.lastError = result.error ?? "unknown error";
      state.failureCount += 1;
      console.error(
        `[login-state] failed after ${elapsed}ms: ${state.lastError}`,
      );
      return false;
    } catch (e) {
      const elapsed = Date.now() - t0;
      state.completedAt = Date.now();
      state.lastDurationMs = elapsed;
      state.status = "failed";
      state.lastError = e instanceof Error ? e.message : String(e);
      state.failureCount += 1;
      console.error(
        `[login-state] threw after ${elapsed}ms: ${state.lastError}`,
      );
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Reset to idle. Useful after `autoLoginIfConfigured` at startup so the
 * state doesn't say `logged_in` until the user has actually triggered
 * something — keeps the semantics "this is about re-auth that surprised us
 * mid-action", not "did we ever log in successfully".
 */
export function resetLoginState(): void {
  state.status = "idle";
  state.pendingAction = null;
  state.startedAt = null;
  state.completedAt = null;
  state.lastDurationMs = null;
  state.lastError = null;
}
