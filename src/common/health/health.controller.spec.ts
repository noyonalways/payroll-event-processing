import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HealthController } from './health.controller';
import { PrismaService } from '../../prisma/prisma.service';

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
  let prismaService: { $queryRaw: jest.Mock };
  let redisCreateClient: jest.Mock;

  beforeEach(async () => {
    prismaService = {
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    };

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
    it('should return status ok when DB and Redis are reachable', async () => {
      prismaService.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      const result = await controller.check();

      expect(result.status).toBe('ok');
      expect(result.db).toBe('ok');
      expect(result.redis).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(result.timestamp).toBeDefined();
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
});
