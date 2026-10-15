import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { HealthController } from './health.controller';
import { PrismaService } from '@repo/database';
import { PAYROLL_EVENTS_QUEUE } from '@repo/database';

// Mock the redis module to avoid real connections in unit tests
jest.mock('redis', () => ({
  createClient: jest.fn().mockReturnValue({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
}));

describe('HealthController', () => {
  let controller: HealthController;
  let prismaService: {
    $queryRaw: jest.Mock;
    workerHeartbeat: { findMany: jest.Mock };
  };
  let redisCreateClient: jest.Mock;
  const queue = { getJobCounts: jest.fn() };

  beforeEach(async () => {
    prismaService = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      workerHeartbeat: { findMany: jest.fn().mockResolvedValue([]) },
    };
    queue.getJobCounts.mockResolvedValue({ stalled: 0 });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: prismaService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultVal?: unknown) => {
              if (key === 'REDIS_HOST') return 'localhost';
              if (key === 'REDIS_PORT') return 6379;
              return defaultVal;
            }),
          },
        },
        { provide: getQueueToken(PAYROLL_EVENTS_QUEUE), useValue: queue },
      ],
    }).compile();

    controller = module.get<HealthController>(HealthController);

    // Get the mocked createClient
    const redis = await import('redis');
    redisCreateClient = redis.createClient as unknown as jest.Mock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Scenario: All dependencies healthy', () => {
    it('should return status ok when DB, Redis, workers, and queue are healthy', async () => {
      prismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      prismaService.workerHeartbeat.findMany.mockResolvedValue([]);
      queue.getJobCounts.mockResolvedValue({ stalled: 0 });

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect(result.db).toBe('ok');
      expect(result.redis).toBe('ok');
      expect(result.workers).toEqual([]);
      expect(result.stalled).toBe(0);
      expect(typeof result.uptime).toBe('number');
      expect(result.timestamp).toBeDefined();
    });

    it('reports fresh workers as not stale', async () => {
      const lastSeenAt = new Date(); // fresh — within the 15s default window
      prismaService.workerHeartbeat.findMany.mockResolvedValue([
        {
          workerId: 'WIN-HOST123:4500',
          hostname: 'WIN-HOST123',
          lastSeenAt,
        },
      ]);

      const result = await controller.check();

      expect(result.workers).toEqual([
        { workerId: 'WIN-HOST123:4500', hostname: 'WIN-HOST123', lastSeenAt: lastSeenAt.toISOString(), stale: false },
      ]);
      expect(result.status).toBe('ok');
    });
  });

  describe('Scenario: Database unreachable', () => {
    it('should return degraded when DB fails', async () => {
      prismaService.$queryRaw.mockRejectedValue(new Error('Connection refused'));

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect(result.db).toBe('error');
      expect(result.redis).toBe('ok');
    });
  });

  describe('Scenario: Redis unreachable', () => {
    it('should return degraded when Redis fails', async () => {
      redisCreateClient.mockReturnValue({
        connect: jest.fn().mockRejectedValue(new Error('Redis connection refused')),
        ping: jest.fn(),
        disconnect: jest.fn().mockResolvedValue(undefined),
      });

      const result = await controller.check();

      expect(result.status).toBe('degraded');
      expect(result.db).toBe('ok');
      expect(result.redis).toBe('error');
    });
  });

  describe('Scenario: Stale worker heartbeat (design D4)', () => {
    it('should return degraded when a worker heartbeat is older than HEALTH_WORKER_STALE_MS', async () => {
      const staleSeenAt = new Date(Date.now() - 60_000); // 60s old > 15s default
      prismaService.workerHeartbeat.findMany.mockResolvedValue([
        { workerId: 'old-worker', hostname: 'WIN-HOST123', lastSeenAt: staleSeenAt },
      ]);

      const result = await controller.check();

      expect(result.workers[0].stale).toBe(true);
      expect(result.status).toBe('degraded');
    });
  });

  describe('Scenario: Stalled BullMQ jobs (R4)', () => {
    it('should return degraded when the queue reports stalled > 0', async () => {
      queue.getJobCounts.mockResolvedValue({ stalled: 2 });

      const result = await controller.check();

      expect(result.stalled).toBe(2);
      expect(result.status).toBe('degraded');
    });
  });

  describe('Scenario: health helpers must not mask the dependency error', () => {
    it('degrades solely through the DB error when both heartbeat and queue checks fail too', async () => {
      // The "Redis unreachable" test replaced the default client — restore it.
      redisCreateClient.mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        ping: jest.fn().mockResolvedValue('PONG'),
        disconnect: jest.fn().mockResolvedValue(undefined),
      });
      prismaService.$queryRaw.mockRejectedValue(new Error('Connection refused'));
      prismaService.workerHeartbeat.findMany.mockRejectedValue(new Error('db down'));
      queue.getJobCounts.mockRejectedValue(new Error('redis down'));

      const result = await controller.check();

      expect(result.db).toBe('error');
      expect(result.redis).toBe('ok');
      expect(result.workers).toEqual([]);
      expect(result.stalled).toBe(0);
      expect(result.status).toBe('degraded');
    });
  });
});