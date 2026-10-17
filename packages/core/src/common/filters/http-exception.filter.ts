import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
// Type-only import: the body shape is the single workspace copy in @repo/shared
// (design D2 — the UI's hand-written duplicate of it was deleted in task 9).
import { ErrorResponseBody } from '@repo/shared';
import { captureError } from '../../telemetry/error-tracking';
import { MetricsService } from '../../telemetry/metrics.service';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  /** Optional so app boots without telemetry (e.g. minimal harnesses). */
  constructor(private readonly metrics?: MetricsService) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception.getResponse();

    const message: string | string[] =
      typeof exceptionResponse === 'object' && 'message' in exceptionResponse
        ? ((exceptionResponse as Record<string, unknown>).message as string | string[])
        : exception.message;

    const errorBody: ErrorResponseBody = {
      statusCode: status,
      message,
      error: exception.name,
      timestamp: new Date().toISOString(),
      path: request.url,
    };

    // 429s carry Retry-After (auth-hardening design D1): the lockout's own
    // exception cause carries the seconds; the throttler computes its own.
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      const cause = (
        exception as HttpException & { getCause?: () => { retryAfterSeconds?: number } }
      ).getCause?.();
      const retryAfter = cause?.retryAfterSeconds ?? 60;
      response.setHeader('Retry-After', String(retryAfter));
    }

    this.logger.warn(`HTTP ${status} — ${request.method} ${request.url}: ${JSON.stringify(message)}`);

    // The filter is the SINGLE recorder of exception-path statuses (design
    // D2): guard-rethrown 401s, validation 400s, conflicts — they never cross
    // an interceptor's success path. Fail-soft, like every recorder.
    try {
      this.metrics?.recordHttpCount(request, status);
    } catch { /* instrumentation never alters the response */ }

    // 5xx-only capture (observability design D4): 4xx client errors are log
    // events, not incidents. Identifiers as tags; the tracker never alters
    // the response (fail-soft by contract).
    if (status >= 500) {
      const actor = (
        request as Request & {
          actor?: { userId?: string; organizationId?: string };
        }
      ).actor;
      captureError(exception, {
        path: request.url,
        method: request.method,
        ...(actor?.userId ? { userId: actor.userId } : {}),
        ...(actor?.organizationId ? { organizationId: actor.organizationId } : {}),
      });
    }

    response.status(status).json(errorBody);
  }
}
