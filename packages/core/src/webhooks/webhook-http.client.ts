import { Injectable } from '@nestjs/common';

/**
 * Thin fetch wrapper for webhook delivery (integrator-webhooks design D6).
 * Isolated behind an injectable so the relay is unit-testable without network.
 * `timeoutMs` bounds the whole request via AbortController; a timeout looks
 * exactly like any other transient transport error to the caller.
 */
export interface HttpPostResult {
  ok: boolean;
  status: number | null;
  /** Response body excerpt (bounded, sanitized upstream). Null on transport error. */
  bodyExcerpt: string | null;
  /** Transport error message. Null when a response was received. */
  error: string | null;
}

@Injectable()
export class WebhookHttpClient {
  async post(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number,
  ): Promise<HttpPostResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let timerCleared = false;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.byteLength),
          ...headers,
        },
        body: new Uint8Array(body),
        signal: controller.signal,
        // Never follow redirects silently across origins with a signature over
        // the original path — a 3xx is treated by classification as non-2xx.
        redirect: 'manual',
      });
      let bodyExcerpt: string | null = null;
      try {
        const text = await response.text();
        bodyExcerpt = text.slice(0, 512);
      } catch {
        // Response body unreadable — classification relies on the status alone.
      }
      return { ok: response.ok, status: response.status, bodyExcerpt, error: null };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `delivery timeout after ${timeoutMs}ms`
            : error.message
          : String(error);
      return { ok: false, status: null, bodyExcerpt: null, error: message };
    } finally {
      if (!timerCleared) {
        clearTimeout(timeout);
        timerCleared = true;
      }
    }
  }
}
