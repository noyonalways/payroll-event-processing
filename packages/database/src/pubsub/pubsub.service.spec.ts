import { ConfigService } from '@nestjs/config';
import { PubSubService } from './pubsub.service';

/**
 * Config stub returning the DEFAULTS (localhost:6379) — the constructor only
 * reads REDIS_HOST/REDIS_PORT, and the round-trip block below runs against
 * whatever Redis those defaults reach.
 */
const defaultConfig = {
  get: (_key: string, defaultValue?: unknown) => defaultValue,
} as unknown as ConfigService;

/**
 * A live Redis is only reached when one is actually up (docker compose).
 * ioredis retries forever, so the probe is time-capped and the round-trip
 * block degrades to a logged skip when nothing answers — the real-Redis
 * round trip is hard-gated in CI by the @repo/api e2e suite.
 */
async function probeRedis(service: PubSubService, timeoutMs = 2000): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('redis probe timed out')),
        timeoutMs,
      );
      service.subscriber
        .connect()
        .then(() => service.publisher.connect())
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
    return true;
  } catch {
    return false;
  }
}

function receiveWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs),
    ),
  ]);
}

describe('PubSubService', () => {
  it('creates a lazy publisher and a subscriber-mode connection with the configured endpoint', () => {
    const config = {
      get: (key: string, defaultValue?: unknown) =>
        key === 'REDIS_HOST' ? 'redis-host' : key === 'REDIS_PORT' ? 1234 : defaultValue,
    } as unknown as ConfigService;

    const service = new PubSubService(config);

    for (const client of [service.publisher, service.subscriber]) {
      expect(client.options.host).toBe('redis-host');
      expect(client.options.port).toBe(1234);
      expect(client.options.lazyConnect).toBe(true);
      client.disconnect();
    }
    // ioredis requires no per-request retry budget in subscriber mode —
    // commands there must wait out reconnects instead of failing fast.
    expect(service.subscriber.options.maxRetriesPerRequest).toBeNull();
  });

  it('onModuleDestroy closes both connections without rejecting', async () => {
    const service = new PubSubService(defaultConfig);
    service.subscriber.disconnect();
    service.publisher.disconnect();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  describe('round-trip (a live Redis must answer on localhost:6379)', () => {
    let service: PubSubService;
    let redisAvailable = false;

    beforeAll(async () => {
      service = new PubSubService(defaultConfig);
      redisAvailable = await probeRedis(service);
      if (!redisAvailable) {
        console.warn(
          'No Redis on localhost:6379 — skipping the PubSubService round-trip (covered against real Redis in the api e2e suite).',
        );
      }
    });

    afterAll(async () => {
      if (redisAvailable) {
        await service.onModuleDestroy();
      } else {
        service.publisher.disconnect();
        service.subscriber.disconnect();
      }
    });

    it('delivers a published message to the subscribed channel', async () => {
      if (!redisAvailable) return;
      const channel = `pubsub-roundtrip-${Math.random().toString(36).slice(2)}`;
      await service.subscriber.subscribe(channel);
      const received = new Promise<string>((resolve) =>
        service.subscriber.on('message', (ch, message) => resolve(message)),
      );

      const payload = JSON.stringify({ hello: 'world', n: 1 });
      expect(await service.publisher.publish(channel, payload)).toBe(1);

      expect(await receiveWithin(received, 5000)).toBe(payload);
    });
  });
});
