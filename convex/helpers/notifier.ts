/**
 * helpers/notifier.ts — Cycle 3: completes the deferred alert-email delivery
 * path (ADR-002 / ADR-003; docs/design/action_layer.md explicitly deferred
 * "the actual email provider integration behind renderAlertEmailText" to an
 * operator/platform decision). This module is that decision point, made
 * safe-by-default:
 *
 *   - `EmailNotifier` is a tiny, provider-agnostic send interface.
 *   - `ConsoleEmailNotifier` (the DEFAULT) just logs and always reports ok —
 *     no configuration required, never crashes, safe for local dev and any
 *     deployment that hasn't opted into a real provider.
 *   - `ResendEmailNotifier` is the concrete example of a real fetch-based
 *     provider. It is OPT-IN via the `AFR_EMAIL_PROVIDER` env var — nothing
 *     calls it unless an operator explicitly configures it.
 *   - `SmtpEmailNotifier` is intentionally a SHAPE only (constructor + the
 *     same `send` signature), documented rather than implemented: wiring a
 *     real SMTP client is a platform/ops dependency choice (which library,
 *     which transport) out of scope for this cycle. It exists so a future
 *     provider can be dropped in without touching call sites.
 *   - `getConfiguredEmailNotifier()` is the single factory every call site
 *     uses. It NEVER throws: an unset or unrecognized `AFR_EMAIL_PROVIDER`
 *     falls back to `ConsoleEmailNotifier`, so a misconfiguration degrades to
 *     "log it" rather than breaking alert delivery.
 *
 * Also carries a Convex-side mirror of `renderAlertEmailText` from
 * `apps/web/src/lib/delivery.ts`, for the same reason `helpers/delivery.ts`
 * mirrors that file's pure webhook-delivery functions instead of importing
 * them directly (see that file's header — this repo's workspace/tsconfig
 * boundaries make a `convex/` -> `apps/web/` import fragile and untested).
 * KEEP IN SYNC with `apps/web/src/lib/delivery.ts`'s `renderAlertEmailText`.
 */

// ---------------------------------------------------------------------------
// EmailNotifier
// ---------------------------------------------------------------------------

export interface EmailSendResult {
  ok: boolean;
  error?: string;
}

export interface EmailNotifier {
  send(to: string, subject: string, body: string): Promise<EmailSendResult>;
}

/**
 * Default notifier: logs the envelope and always reports success. Used when
 * no provider is configured (`AFR_EMAIL_PROVIDER` unset) so alert-email
 * delivery is never a hard dependency — an operator who hasn't set up a
 * provider still gets a visible record (console/log output) instead of a
 * silently-stuck "pending" delivery or, worse, a crash.
 */
export class ConsoleEmailNotifier implements EmailNotifier {
  send(to: string, subject: string, body: string): Promise<EmailSendResult> {
    console.log(
      `[ConsoleEmailNotifier] to=${to} subject=${JSON.stringify(subject)}\n${body}`,
    );
    return Promise.resolve({ ok: true });
  }
}

/**
 * Concrete fetch-based provider example: Resend (https://resend.com/docs/api-reference/emails/send-email).
 * Constructor takes the API key and the "from" address; never throws on
 * construction. `send` never throws — network/HTTP failures are reported as
 * `{ ok: false, error }`, matching `EmailSendResult`'s contract, so a
 * misbehaving provider can never take down the delivery drain loop.
 */
export class ResendEmailNotifier implements EmailNotifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(to: string, subject: string, body: string): Promise<EmailSendResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [to],
          subject,
          text: body,
        }),
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Resend HTTP ${String(res.status)}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "network error" };
    }
  }
}

/**
 * SHAPE ONLY — not implemented. A concrete SMTP-based notifier (nodemailer
 * or similar) is a platform/ops library choice out of scope for this cycle;
 * this class exists so that choice can be dropped in later without touching
 * any call site (they only ever depend on the `EmailNotifier` interface).
 * Constructing it succeeds; `send` throws immediately as a defensive guard
 * against silently no-op'ing a caller who explicitly asked for SMTP, but
 * `getConfiguredEmailNotifier` never selects this class on its own
 * (`AFR_EMAIL_PROVIDER=smtp` is not currently wired), so unconfigured
 * deployments can never reach this path.
 */
export class SmtpEmailNotifier implements EmailNotifier {
  constructor(
    private readonly config: { host: string; port: number; username: string; password: string },
  ) {}

  send(_to: string, _subject: string, _body: string): Promise<EmailSendResult> {
    void this.config;
    throw new Error(
      "SmtpEmailNotifier is a shape only — no SMTP transport is wired yet. " +
        "Configure AFR_EMAIL_PROVIDER=resend (or leave unset for ConsoleEmailNotifier).",
    );
  }
}

/**
 * The single factory every call site uses. Reads `AFR_EMAIL_PROVIDER`
 * ("resend" | unset/anything else -> console). NEVER throws: a missing
 * `RESEND_API_KEY`/`AFR_EMAIL_FROM` alongside `AFR_EMAIL_PROVIDER=resend`
 * falls back to the console notifier rather than failing the delivery drain
 * — a misconfiguration should degrade gracefully, not crash a cron.
 */
export function getConfiguredEmailNotifier(): EmailNotifier {
  const provider = process.env["AFR_EMAIL_PROVIDER"];
  if (provider === "resend") {
    const apiKey = process.env["RESEND_API_KEY"];
    const from = process.env["AFR_EMAIL_FROM"];
    if (apiKey && from) {
      return new ResendEmailNotifier(apiKey, from);
    }
    console.warn(
      "AFR_EMAIL_PROVIDER=resend but RESEND_API_KEY/AFR_EMAIL_FROM is unset; " +
        "falling back to ConsoleEmailNotifier.",
    );
  }
  return new ConsoleEmailNotifier();
}

// ---------------------------------------------------------------------------
// renderAlertEmailText mirror — KEEP IN SYNC with apps/web/src/lib/delivery.ts
// ---------------------------------------------------------------------------

/**
 * Minimal shape this renderer needs from a fired alert. Mirrors
 * `AlertEmailInput` in apps/web/src/lib/delivery.ts exactly.
 */
export interface AlertEmailInput {
  alertName: string;
  orgName: string;
  runId: string;
  runStatus: string;
  agentName: string;
  firedAt: number;
  /** Human-readable condition that triggered the alert, e.g. "run.failed". */
  condition: string;
  /** Link back to the run in the web UI. */
  runUrl: string;
}

/** Convex-side mirror of apps/web/src/lib/delivery.ts's renderAlertEmailText. */
export function renderAlertEmailText(alert: AlertEmailInput): string {
  const firedAtIso = new Date(alert.firedAt).toISOString();
  return [
    `Agent Flight Recorder alert: ${alert.alertName}`,
    "",
    `Organization: ${alert.orgName}`,
    `Agent:        ${alert.agentName}`,
    `Run:          ${alert.runId}`,
    `Status:       ${alert.runStatus}`,
    `Condition:    ${alert.condition}`,
    `Fired at:     ${firedAtIso}`,
    "",
    `View run: ${alert.runUrl}`,
    "",
    "— Agent Flight Recorder",
  ].join("\n");
}
