import { PermanentPayrollFailureError, TransientPayrollFailureError } from '@repo/shared';
import {
  ExternalPayrollOperation,
  ExternalPayrollResult,
} from './external-payroll-provider';
import { ProviderHttpClient } from './provider-http.client';

/** The resolved HTTP configuration one adapter instance serves. */
export interface HttpProviderTarget {
  baseUrl: string;
  credential: string;
}

/** Response-body field the endpoint MUST return on success (design D4). */
const REFERENCE_FIELD = 'reference';
/** Longest response-text excerpt stored as a permanent failure reason. */
const MAX_REASON_LENGTH = 300;

/**
 * The HTTP external payroll provider (real-provider-adapter design D4): POSTs
 * the operation contract to the organization's endpoint with its credential
 * and classifies protocol outcomes into the two failure classes the rest of
 * the pipeline already understands:
 *
 * - `2xx` + non-empty `reference` → success.
 * - `2xx` without a usable reference / network error / timeout / `5xx` →
 *   TRANSIENT (the server answered wrong or not at all; retry may succeed).
 * - `4xx` → PERMANENT carrying a bounded, sanitized rejection excerpt
 *   (business rejection; retrying cannot fix it).
 *
 * Reasons never include credentials; bodies are excerpted and header-less.
 */
export class HttpPayrollProvider {
  constructor(
    private readonly target: HttpProviderTarget,
    private readonly httpClient: ProviderHttpClient,
    private readonly timeoutMs: number,
  ) {}

  readonly kind = 'http' as const;

  async apply(operation: ExternalPayrollOperation): Promise<ExternalPayrollResult> {
    try {
      return await this.doApply(operation);
    } catch (error) {
      // The credential is scrubbed from EVERY raised failure — the transport
      // client is third-party-input territory (echoing servers, diagnostics),
      // so no adapter-raised message can be trusted to be clean.
      if (error instanceof TransientPayrollFailureError) {
        throw new TransientPayrollFailureError(this.scrub(error.message));
      }
      if (error instanceof PermanentPayrollFailureError) {
        throw new PermanentPayrollFailureError(this.scrub(error.message));
      }
      throw error;
    }
  }

  private scrub(message: string): string {
    return message.split(this.target.credential).join('[redacted]');
  }

  private async doApply(operation: ExternalPayrollOperation): Promise<ExternalPayrollResult> {
    const rawBody = Buffer.from(
      JSON.stringify({
        eventId: operation.eventId,
        organizationId: operation.organizationId,
        employeeId: operation.employeeId,
        eventType: operation.eventType,
        sequence: operation.sequence,
        payload: operation.payload,
        attempt: operation.attempt,
      }),
      'utf8',
    );
    const result = await this.httpClient.post(
      this.target.baseUrl,
      { Authorization: `Bearer ${this.target.credential}` },
      rawBody,
      this.timeoutMs,
    );

    // Transport error (network/timeout) → transient.
    if (result.error !== null) {
      throw new TransientPayrollFailureError(
        `provider transport failure: ${result.error}`,
      );
    }

    const status = result.status ?? 0;
    if (status >= 200 && status < 300) {
      const reference = result.body?.[REFERENCE_FIELD];
      if (typeof reference === 'string' && reference.trim() !== '') {
        return { reference };
      }
      // A 2xx without a usable reference means the endpoint answered wrong —
      // the same operation may answer right on a retry.
      throw new TransientPayrollFailureError(
        `provider response ${status} lacks a usable '${REFERENCE_FIELD}'`,
      );
    }

    if (status >= 400 && status < 500) {
      throw new PermanentPayrollFailureError(
        `provider rejected with ${status}` +
          (result.body ? `: ${this.sanitizedExcerpt(result.body)}` : ''),
      );
    }

    // 5xx (and anything unclassifiable) → transient.
    throw new TransientPayrollFailureError(`provider server error ${status}`);
  }

  /**
   * Bounded JSON excerpt for the failure reason. An echoing endpoint can
   * reflect the Authorization credential in its error body — the credential is
   * scrubbed FIRST, then the text is bounded (a leak must not depend on where
   * it sits in the string).
   */
  private sanitizedExcerpt(body: Record<string, unknown>): string {
    try {
      let text = JSON.stringify(body).split(this.target.credential).join('[redacted]');
      text =
        text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
      return text;
    } catch {
      return '[unserializable body]';
    }
  }
}
