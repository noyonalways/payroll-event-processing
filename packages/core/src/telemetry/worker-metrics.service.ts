import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Server } from 'http';
import { PrismaService } from '@repo/database';
import { PAYROLL_EVENTS_QUEUE } from '@repo/shared';
import { MetricsService } from './metrics.service';

/**
 * Worker-side telemetry (observability design D2): a standalone metrics
 * listener on `WORKER_METRICS_PORT` (the worker has no HTTP server) plus the
 * queue/heartbeat gauges polled on one shared interval.
 *
 * Fail-soft by contract: a Redis outage or a DB error during polling records
 * `payroll_queue_metrics_errors_total` and keeps the LAST gauge values — the
 * relays and the processor are never blocked, delayed, or crashed by
 * instrumentation (spec: fail-soft recording).
 */
@Injectable()
export class WorkerMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerMetricsService.name);
  private readonly port: number;
  private readonly pollMs: number;
  private readonly staleMs: number;
  private server: Server | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    config: ConfigService,
    @InjectQueue(PAYROLL_EVENTS_QUEUE) private readonly queue: Queue,
  ) {
    this.port = config.get<number>('WORKER_METRICS_PORT') ?? 9101;
    this.pollMs = config.get<number>('METRICS_QUEUE_POLL_MS') ?? 5_000;
    this.staleMs = config.get<number>('HEALTH_WORKER_STALE_MS') ?? 15_000;
  }

  onModuleInit(): void {
    this.startListener();
    this.scheduleNextPoll(0);
    this.logger.log(
      `Worker metrics listener on :${this.port} (queue poll every ${this.pollMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.server?.close();
  }

  /** The exposition surface — scrapeable from the host network. */
  private startListener(): void {
    // node:http keeps the worker free of an HTTP framework dependency.
    const http = require('http') as typeof import('http');
    this.server = http.createServer(
      async (_req, res) => {
        try {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
          res.end(await this.metrics.renderMetrics());
        } catch (error) {
          res.statusCode = 500;
          res.end(`# metrics rendering failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    );
    this.server.listen(this.port, '0.0.0.0');
  }

  private scheduleNextPoll(delayMs: number): void {
    // setTimeout CHAIN (never setInterval): a slow poll cannot overlap itself.
    this.timer = setTimeout(() => {
      void this.poll();
    }, delayMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    let delay = this.pollMs;
    try {
      const counts = await this.queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      this.metrics.setQueueCounts({
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      });
    } catch (error) {
      // Redis down: keep last values, count the scrape failure, keep going.
      this.metrics.recordQueueMetricsError();
      delay = Math.min(this.pollMs, 1_000);
      this.logger.warn(
        `Queue metrics poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      const staleDeadline = new Date(Date.now() - this.staleMs);
      const stale = await this.prisma.workerHeartbeat.count({
        where: { lastSeenAt: { lt: staleDeadline } },
      });
      this.metrics.setStaleHeartbeats(stale);
    } catch {
      // DB hiccup: the /health probe remains the liveness authority; keep going.
      this.metrics.recordQueueMetricsError();
    }

    this.scheduleNextPoll(delay);
  }
}
