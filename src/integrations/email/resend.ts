/**
 * Resend email provider.
 *
 * Thin wrapper over Resend's REST API (POST /emails). No SDK dep on
 * purpose — ohwow prefers fetch-against-provider over adding a
 * transitive-heavy package for a single endpoint.
 *
 * Usage
 * -----
 *   import { createResendSender } from '...';
 *   const send = createResendSender({
 *     getApiKey: async () => process.env.RESEND_API_KEY,
 *     fromAddress: 'Outreach <outreach@example.com>',
 *   });
 *   const result = await send({ to, subject, text, html });
 *
 * Rate limits
 * -----------
 * Resend returns 429 with a JSON error body. The sender surfaces the
 * retry hint in the returned error shape so the caller (dispatcher)
 * can hold the approval for a retry tick instead of marking it
 * applied.
 *
 * Kill switch
 * -----------
 * `getApiKey()` returning undefined → `{ ok: false, reason:
 * 'no_api_key' }`. Dispatcher treats this as "not configured" and
 * doesn't retry the specific approval — it waits for the key to be
 * set before sending anything.
 */

import { logger } from '../../lib/logger.js';

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  /** Optional tags the provider tracks (Resend supports up to 10). */
  tags?: Array<{ name: string; value: string }>;
  /**
   * Optional idempotency key (Resend SDK calls this "idempotencyKey").
   * We forward it as the `Idempotency-Key` header so repeat sends with
   * the same key don't duplicate the email. Callers pass the approval
   * entry id so a replay-through-the-dispatcher doesn't double-send.
   */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  ok: boolean;
  providerId?: string;
  reason?: string;
  status?: number;
  retryAfterMs?: number;
}

export interface ResendSenderOptions {
  /** Async getter so the key can come from runtime_settings / env. */
  getApiKey: () => Promise<string | undefined>;
  fromAddress: string;
  /** Defaults to https://api.resend.com — overridable for tests. */
  baseUrl?: string;
  /** Defaults to globalThis.fetch. Tests inject. */
  fetchImpl?: typeof fetch;
}

export type EmailSender = (input: SendEmailInput) => Promise<SendEmailResult>;

function parseRetryAfterHeader(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const absMs = Date.parse(raw);
  if (Number.isFinite(absMs)) {
    const ms = absMs - Date.now();
    return ms > 0 ? ms : undefined;
  }
  return undefined;
}

export function createResendSender(opts: ResendSenderOptions): EmailSender {
  const baseUrl = opts.baseUrl ?? 'https://api.resend.com';
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async function send(input: SendEmailInput): Promise<SendEmailResult> {
    const apiKey = await opts.getApiKey();
    if (!apiKey) return { ok: false, reason: 'no_api_key' };
    if (!input.to || (Array.isArray(input.to) && input.to.length === 0)) {
      return { ok: false, reason: 'missing_to' };
    }
    if (!input.subject) return { ok: false, reason: 'missing_subject' };
    if (!input.text && !input.html) return { ok: false, reason: 'missing_body' };

    const body: Record<string, unknown> = {
      from: opts.fromAddress,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
    };
    if (input.text) body.text = input.text;
    if (input.html) body.html = input.html;
    if (input.replyTo) body.reply_to = input.replyTo;
    if (input.tags && input.tags.length > 0) body.tags = input.tags;

    const headers: Record<string, string> = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    };
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/emails`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[resend] fetch threw');
      return { ok: false, reason: 'fetch_failed' };
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
      logger.info({ retryAfterMs }, '[resend] rate limited');
      return { ok: false, reason: 'rate_limited', status: 429, retryAfterMs };
    }

    let parsed: { id?: string; message?: string } | null = null;
    try {
      parsed = await response.json() as { id?: string; message?: string };
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message = parsed?.message ?? `status ${response.status}`;
      logger.warn({ status: response.status, message }, '[resend] send failed');
      return { ok: false, reason: message, status: response.status };
    }
    if (!parsed?.id) {
      return { ok: false, reason: 'no_provider_id', status: response.status };
    }
    return { ok: true, providerId: parsed.id, status: response.status };
  };
}

/**
 * Append `?t=<outreachToken>` (or `&t=<outreachToken>`) to the given
 * URL. Used by the email-dispatcher to embed attribution tokens into
 * CTA links just before send — keeps the draft approval payload
 * clean of per-contact state.
 */
export function attachOutreachTokenToUrl(url: string, token: string): string {
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}t=${encodeURIComponent(token)}`;
}
