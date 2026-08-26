import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Worker liveness heartbeat (design D4). An unref'd `setInterval` bumps
 * `lastSeenAt` on `worker_heartbeats` (upsert keyed on `workerId`) so the API's
 * `/health` can detect a worker that crashed or hung — the heartbeat goes stale
 * and the overall status degrades.
 *
 * `workerId` defaults to `${hostname}:${pid}` (unique per process, stable within
 * a container/pod); set `WORKER_ID` to get a stable logical id across restarts
 * (e.g. a Kubernetes pod name), which keeps `lastSeenAt` aging on the SAME key.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HeartbeatService.name);
  private readonly workerId: string;
  private readonly hostname = os.hostname();
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.workerId =
      this.config.get<string>('WORKER_ID') ?? `${this.hostname}:${process.pid}`;
    this.intervalMs = this.config.get<number>('WORKER_HEARTBEAT_INTERVAL_MS', 5000);
  }

  onModuleInit(): void {
    // Publish the row immediately so /health sees the worker even before the
    // first tick, then keep it fresh with an unref'd timer that never keeps the
    // process alive by itself.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
  }

  /**
   * Immediate liveness bump — called at the start of every `process()` so a
   * long-running job also keeps the heartbeat fresh between ticks.
   */
  async touch(): Promise<void> {
    const now = new Date();
    await this.prisma.workerHeartbeat.upsert({
      where: { workerId: this.workerId },
      update: { lastSeenAt: now },
      create: {
        workerId: this.workerId,
        hostname: this.hostname,
        startedAt: now,
        lastSeenAt: now,
      },
    });
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Guarded tick: a failed upsert must never become an unhandled rejection or
   * kill the timer — the next tick simply retries.
   */
  private async tick(): Promise<void> {
    try {
      await this.touch();
    } catch (error) {
      this.logger.warn(
        `Heartbeat upsert failed (will retry next tick): ${this.errorMessage(error)}`,
      );
    }
  }
}