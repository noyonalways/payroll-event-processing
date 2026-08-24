import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { createClient } from 'redis';
import { HealthResponseDto } from './health-response.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Service health check',
    description:
      'Returns service and dependency (PostgreSQL, Redis) status. Always HTTP 200; ' +
      'consumers use the body to determine health.',
  })
  @ApiResponse({
    status: 200,
    description: 'Service and dependency status',
    type: HealthResponseDto,
  })
  async check(): Promise<HealthResponseDto> {
    const [dbStatus, redisStatus] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const status = dbStatus === 'ok' && redisStatus === 'ok' ? 'ok' : 'degraded';

    const response: HealthResponseDto = {
      status,
      db: dbStatus,
      redis: redisStatus,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    if (status === 'degraded') {
      this.logger.warn('Health check degraded', response);
    }

    return response;
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