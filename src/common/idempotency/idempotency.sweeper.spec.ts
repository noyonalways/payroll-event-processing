import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@repo/database';
import { IdempotencySweeper } from './idempotency.sweeper';

describe('IdempotencySweeper', () => {
  let sweeper: IdempotencySweeper;
  const prisma = {
    idempotencyRecord: { deleteMany: jest.fn() },
  };
  const config = { get: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(undefined); // default 60s interval
    sweeper = new IdempotencySweeper(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('sweepNow', () => {
    it('deletes records whose expiry is in the past and reports the count', async () => {
      prisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 3 });

      const purged = await sweeper.sweepNow();

      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
        where: { expiresAt: { lt: expect.any(Date) } },
      });
      expect(purged).toBe(3);
    });

    it('leaves unexpired records untouched', async () => {
      prisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 0 });

      const purged = await sweeper.sweepNow();

      expect(purged).toBe(0);
    });
  });

  describe('scheduled sweep', () => {
    it('runs a sweep on each interval tick and stops once destroyed', async () => {
      prisma.idempotencyRecord.deleteMany.mockResolvedValue({ count: 0 });
      jest.useFakeTimers();

      sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledTimes(2);

      // onModuleDestroy clears the timer; no further sweeps fire.
      sweeper.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(prisma.idempotencyRecord.deleteMany).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });

    it('logs a failure instead of crashing when a sweep throws', async () => {
      prisma.idempotencyRecord.deleteMany.mockRejectedValue(
        new Error('connection refused'),
      );
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      jest.useFakeTimers();

      sweeper.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining('Idempotency sweep failed'),
      );

      sweeper.onModuleDestroy();
      jest.useRealTimers();
      jest.restoreAllMocks();
    });
  });
});