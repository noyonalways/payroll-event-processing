import * as os from 'os';
import { HeartbeatService } from './heartbeat.service';
import { PrismaService } from '@repo/database';
import { ConfigService } from '@nestjs/config';

/**
 * Unit coverage for the worker liveness heartbeat (design D4): upsert shape
 * (workerId/hostname/startedAt/lastSeenAt), the default workerId from
 * `${hostname}:${pid}`, immediate bump + unref'd interval lifecycle, and
 * timer cleanup on destroy.
 */
describe('HeartbeatService', () => {
  const prisma = { workerHeartbeat: { upsert: jest.fn() } };
  const config = { get: jest.fn() };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    config.get.mockImplementation((key: string) => {
      if (key === 'WORKER_ID') {
        return 'worker-abc';
      }
      if (key === 'WORKER_HEARTBEAT_INTERVAL_MS') {
        return 5000;
      }
      return undefined;
    });
    prisma.workerHeartbeat.upsert.mockResolvedValue({
      workerId: 'worker-abc',
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const build = () =>
    new HeartbeatService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );

  it('uses WORKER_ID when set (stable logical id across restarts)', () => {
    expect(build()['workerId']).toBe('worker-abc');
    expect(build()['hostname']).toBe(os.hostname());
  });

  it("falls back to `${hostname}:${pid}` otherwise", () => {
    config.get.mockReturnValue(undefined);
    expect(build()['workerId']).toBe(`${os.hostname()}:${process.pid}`);
  });

  it('upserts workerId/hostname/startedAt/lastSeenAt on touch', async () => {
    const service = build();
    await service.touch();

    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledWith({
      where: { workerId: 'worker-abc' },
      update: { lastSeenAt: expect.any(Date) },
      create: {
        workerId: 'worker-abc',
        hostname: os.hostname(),
        startedAt: expect.any(Date),
        lastSeenAt: expect.any(Date),
      },
    });
    const { update } = prisma.workerHeartbeat.upsert.mock.calls[0][0];
    expect(update.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 10_000);
  });

  it('publishes immediately on init and ticks every WORKER_HEARTBEAT_INTERVAL_MS', async () => {
    const service = build();

    expect(prisma.workerHeartbeat.upsert).not.toHaveBeenCalled();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0); // flush the immediate touch

    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5000);
    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(5000);
    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(3);

    service.onModuleDestroy();
  });

  it('clears the timer on destroy (no further touches)', async () => {
    const service = build();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(30_000);

    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(1);
  });

  it('survives an upsert failure and keeps ticking', async () => {
    prisma.workerHeartbeat.upsert.mockRejectedValueOnce(new Error('db down'));
    const service = build();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5000);

    expect(prisma.workerHeartbeat.upsert).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});