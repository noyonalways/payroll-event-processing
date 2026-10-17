import { Injectable } from '@nestjs/common';

/**
 * Thin fetch wrapper for the external payroll provider
 * (real-provider-adapter design D4) — injectable so the adapter's
 * classification matrix is unit-testable without a network.
 */
export interface ProviderPostResult {
  status: number | null;
  /** Parsed JSON body, or `null` when the body is unparsable/absent. */
  body: Record<string, unknown> | null;
  /** Transport error message (network/timeout). Null with a received status. */
  error: string | null;
}

@Injectable()
export class ProviderHttpClient {
  async post(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number,
  ): Promise<ProviderPostResult> {
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
        redirect: 'manual',
      });
      let parsed: Record<string, unknown> | null = null;
      try {
        const text = await response.text();
        if (text.trim() !== '') {
          parsed = JSON.parse(text) as Record<string, unknown>;
        }
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, error: null };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `provider timeout after ${timeoutMs}ms`
            : error.message
          : String(error);
      return { status: null, body: null, error: message };
    } finally {
      if (!timerCleared) {
        clearTimeout(timeout);
        timerCleared = true;
      }
    }
  }
}
