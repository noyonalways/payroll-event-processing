import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { createClient } from 'redis';
import { PAYROLL_EVENTS_QUEUE } from '../../queue/queue.constants';
import { Public } from '../../auth/decorators/public.decorator';
import { HealthResponseDto } from './health-response.dto';
import { WorkerLivenessDto } from './worker-liveness.dto';

/**
 * Liveness/health for the service and its dependencies.
 *
 * `@Public()` on purpose: this is the endpoint an orchestrator probes before any
 * credential exists (container health checks, load balancers), and it exposes only
 * infrastructure status — never tenant data. Everything else in the application is
 * authenticated by the global guard.
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue(PAYROLL_EVENTS_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Service health check',
    description:
      'Returns service, dependency (PostgreSQL, Redis), worker liveness, and queue ' +
      'stall status. Always HTTP 200; consumers use the body to determine health. ' +
      'Status is degraded when any dependency is unreachable, any worker heartbeat ' +
      'is stale (HEALTH_WORKER_STALE_MS), or BullMQ reports stalled jobs.',
  })
  @ApiResponse({
    status: 200,
    description: 'Service, dependency, worker, and queue status',
    type: HealthResponseDto,
  })
  async check(): Promise<HealthResponseDto> {
    const staleMs = this.configService.get<number>('HEALTH_WORKER_STALE_MS', 15000);

    const [dbStatus, redisStatus, workers, stalled] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkWorkers(staleMs),
      this.checkStalledJobs(),
    ]);

    const anyStaleWorker = workers.some((worker) => worker.stale);
    const status =
      dbStatus === 'ok' &&
      redisStatus === 'ok' &&
      !anyStaleWorker &&
      stalled === 0
        ? 'ok'
        : 'degraded';

    const response: HealthResponseDto = {
      status,
      db: dbStatus,
      redis: redisStatus,
      workers,
      stalled,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    if (status === 'degraded') {
      this.logger.warn('Health check degraded', response);
    }

    return response;
  }

  /**
   * Worker liveness (design D4): every row of `worker_heartbeats` ages against
   * HEALTH_WORKER_STALE_MS. A heartbeat failure (DB down) is NOT a hard fail for
   * this helper — the DB check already surfaces that — it just reports no
   * workers so the overall status reflects the dependency error instead.
   */
  private async checkWorkers(staleMs: number): Promise<WorkerLivenessDto[]> {
    try {
      const rows = await this.prisma.workerHeartbeat.findMany({
        orderBy: { lastSeenAt: 'desc' },
        select: { workerId: true, hostname: true, lastSeenAt: true },
      });
      const cutoff = Date.now() - staleMs;
      return rows.map((row) => ({
        workerId: row.workerId,
        hostname: row.hostname,
        lastSeenAt: row.lastSeenAt.toISOString(),
        stale: row.lastSeenAt.getTime() < cutoff,
      }));
    } catch (error) {
      this.logger.error('Worker heartbeat check failed', error);
      return [];
    }
  }

  /**
   * BullMQ stalled-job count (R4). A queue call failure (Redis down) is a soft
   * fail: the Redis check already degrades the overall status, and an empty
   * stalled count keeps this helper from masking the dependency error.
   */
  private async checkStalledJobs(): Promise<number> {
    try {
      const counts = await this.queue.getJobCounts();
      return (counts as { stalled?: number }).stalled ?? 0;
    } catch (error) {
      this.logger.error('Queue stalled-count check failed', error);
      return 0;
    }
  }

  private async checkDatabase(): Promise<'ok' | 'error'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch (error) {
      this.logger.error('Database health check failed', error);
      return 'error';
    }
  }

  private async checkRedis(): Promise<'ok' | 'error'> {
    const host = this.configService.get<string>('REDIS_HOST', 'localhost');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const client = createClient({ socket: { host, port, connectTimeout: 3000 } });

    try {
      await client.connect();
      await client.ping();
      return 'ok';
    } catch (error) {
      this.logger.error('Redis health check failed', error);
      return 'error';
    } finally {
      try {
        await client.disconnect();
      } catch {
        // ignore disconnect errors
      }
    }
  }
}