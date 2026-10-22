import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Global,
  Injectable,
  Module,
  NestInterceptor,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { tap } from 'rxjs';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * GET /metrics (observability design D1): Prometheus exposition on the API's
 * own port, credential-free in exactly the posture of GET /health — service
 * metrics only, no organization-owned data, no organization parameter taken.
 */
@Public() // same exposure posture as GET /health (scrapes carry no tokens)
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async payload(@Res() response: Response): Promise<void> {
    // Prometheus exposition format — text/plain is part of the scrape
    // contract (a JSON content type would break real scrapers).
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(await this.metrics.renderMetrics());
  }
}

/**
 * HTTP request metrics (observability design D2). The route label is the
 * CANONICAL pattern (`/events/:id`), never the raw path — masked ids and
 * unmatched routes fall into the bounded `unmatched` label: label cardinality
 * cannot grow with traffic. Recording is synchronous in-memory work wrapped
 * fail-soft: an instrumentation error can never alter the response.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      route?: { path?: string; baseUrl?: string };
      method?: string;
      originalUrl?: string;
    }>();

    // Scrapes must not count themselves (scrape cadence would dominate).
    if (request.originalUrl?.startsWith('/metrics')) {
      return next.handle();
    }

    const startedAt = process.hrtime.bigint();
    const record = (status: number) => {
      try {
        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
        this.metrics.recordHttp(request, status, seconds);
      } catch {
        // fail-soft: metrics never alter the request.
      }
    };

    return next.handle().pipe(
      tap({
        next: () => {
          // The response status IS set by the time the success tap runs.
          const response = context.switchToHttp().getResponse<{
            statusCode?: number;
          }>();
          record(response.statusCode ?? 200);
        },
        error: (error: unknown) => {
          // Count ONLY the duration here; the exception filter is the single
          // writer of the exception-path STATUS (guard 401s and controller
          // exceptions both land there — never double counted).
          try {
            const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
            this.metrics.recordHttpDurationOnly(
              request,
              seconds,
            );
          } catch {
            // fail-soft
          }
          void error;
        },
      }),
    );
  }
}

/**
 * The telemetry surface for the API process: the /metrics controller and the
 * global HTTP interceptor. Worker-only pieces (metrics listener, queue gauge
 * poller) live in the worker composition root, which imports this module for
 * the shared MetricsService.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // After the auth machinery in registration order; it only READS request
    // state, so this is about lifecycle hygiene, not security ordering.
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class TelemetryModule {}
