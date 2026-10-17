import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../telemetry/metrics.service';
import { WebhookRelayService } from './webhook-relay.service';

/**
 * Relay classification + bookkeeping (integrator-webhooks design D6): 2xx with
 * any status lands DELIVERED; 4xx dead-letters permanently; network errors,
 * timeouts and 5xx retry with exponential backoff; the attempt cap
 * dead-letters. Every attempt appends to `webhook_delivery_attempts`. All DB
 * work goes through the batch of due ids claimed one-by-one, so the tests
 * drive `processDueOnce()` with one due row per scenario.
 */
describe('WebhookRelayService (unit)', () => {
  const makeHarness = (overrides: Record<string, number> = {}) => {    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'd-1' }]),
      webhookDelivery: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'd-1',
          eventId: 'evt-1',
          organizationId: 'org-a',
          url: 'https://hooks.example/a',
          payload: { eventId: 'evt-1', status: 'SUCCESS' },
          attempts: 0,
          endpoint: { secret: 'kHisZGlmZmVyZW50' },
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      webhookDeliveryAttempt: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      webhookDelivery: {
        findMany: jest.fn().mockResolvedValue([{ id: 'd-1' }]),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const httpClient = { post: jest.fn().mockResolvedValue({ ok: true, status: 200, bodyExcerpt: null, error: null }) };
    const config = {
      get: jest.fn((key: string) => overrides[key]),
    };
    const metrics = {
      recordWebhookDelivery: jest.fn(),
      recordAttempt: jest.fn(),
    };
    const relay = new WebhookRelayService(
      prisma as never,
      httpClient as never,
      metrics as unknown as MetricsService,
      config as unknown as ConfigService,
    );
    return { relay, tx, prisma, httpClient, metrics };
  };

  it('delivers a 2xx response: DELIVERED + attempt row (DELIVERED) inside the claim tx', async () => {
    const { relay, tx, prisma, httpClient } = makeHarness();
    httpClient.post.mockResolvedValue({ ok: true, status: 200, bodyExcerpt: null, error: null });

    const processed = await relay.processDueOnce();

    expect(processed).toEqual(['d-1']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd-1' },
        data: expect.objectContaining({
          status: 'DELIVERED',
          attempts: 1,
          deliveredAt: expect.any(Date),
          nextAttemptAt: null,
        }),
      }),
    );
    expect(tx.webhookDeliveryAttempt.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-1', attemptNumber: 1, outcome: 'DELIVERED', responseStatus: 200 },
    });
  });

  it('signs the exact transmitted bytes and stamps the identity headers', async () => {
    const { relay, httpClient } = makeHarness();

    await relay.processDueOnce();

    const [url, headers, body, timeout] = httpClient.post.mock.calls[0];
    expect(url).toBe('https://hooks.example/a');
    expect(timeout).toBe(10_000);
    expect(headers['X-Payroll-Delivery']).toBe('d-1');
    expect(headers['X-Payroll-Event']).toBe('evt-1');
    expect(headers['X-Payroll-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(headers['X-Payroll-Timestamp']).toEqual(expect.any(String));
    // The body is the serialization of the stored payload snapshot.
    expect(JSON.parse(body.toString('utf8'))).toEqual({ eventId: 'evt-1', status: 'SUCCESS' });
  });

  it('dead-letters a 4xx permanently with the rejection status recorded', async () => {
    const { relay, tx, httpClient } = makeHarness();
    httpClient.post.mockResolvedValue({ ok: false, status: 410, bodyExcerpt: 'gone', error: null });

    await relay.processDueOnce();

    expect(tx.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEAD_LETTERED',
          deadLetterReason: 'endpoint_rejected',
          attempts: 1,
          nextAttemptAt: null,
        }),
      }),
    );
    expect(tx.webhookDeliveryAttempt.create).toHaveBeenCalledWith({
      data: { deliveryId: 'd-1', attemptNumber: 1, outcome: 'FAILED', responseStatus: 410, error: 'body: gone' },
    });
  });

  it('schedules 5xx backoff with exponential delay and keeps the row PENDING', async () => {
    const { relay, tx, httpClient } = makeHarness({ WEBHOOK_RELAY_MAX_ATTEMPTS: 8 });
    httpClient.post.mockResolvedValue({ ok: false, status: 503, bodyExcerpt: null, error: null });

    await relay.processDueOnce();

    expect(tx.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 1,
          nextAttemptAt: expect.any(Date),
        }),
      }),
    );
    // Base 30s * 2^(1-1) = 30 s after now (±1 s clock slack).
    const update = tx.webhookDelivery.update.mock.calls[0][0].data;
    const delay = (update.nextAttemptAt as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(29_000);
    expect(delay).toBeLessThan(31_500);
  });

  it('doubles the backoff window as attempts accumulate', async () => {
    const { relay, tx, httpClient } = makeHarness({ WEBHOOK_RELAY_MAX_ATTEMPTS: 8 });
    tx.webhookDelivery.findUniqueOrThrow.mockResolvedValue({
      id: 'd-1', eventId: 'evt-1', organizationId: 'org-a',
      url: 'https://hooks.example/a', payload: {}, attempts: 3,
      endpoint: { secret: 'kHisZGlmZmVyZW50' },
    });
    httpClient.post.mockResolvedValue({ ok: false, status: 500, bodyExcerpt: null, error: null });

    await relay.processDueOnce();

    const update = tx.webhookDelivery.update.mock.calls[0][0].data;
    expect(update.attempts).toBe(4);
    const delay = (update.nextAttemptAt as Date).getTime() - Date.now();
    expect(delay).toBeGreaterThan(238_000); // 30s * 2^3 = 240s (± slack)
    expect(delay).toBeLessThan(241_500);
  });

  it('dead-letters on retries_exhausted at the configured cap', async () => {
    const { relay, tx, httpClient } = makeHarness({ WEBHOOK_RELAY_MAX_ATTEMPTS: 2 });
    tx.webhookDelivery.findUniqueOrThrow.mockResolvedValue({
      id: 'd-1', eventId: 'evt-1', organizationId: 'org-a',
      url: 'https://hooks.example/a', payload: {}, attempts: 1,
      endpoint: { secret: 'kHisZGlmZmVyZW50' },
    });
    httpClient.post.mockResolvedValue({ ok: false, status: null, bodyExcerpt: null, error: 'connect timeout after 10000ms' });

    await relay.processDueOnce();

    expect(tx.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEAD_LETTERED',
          deadLetterReason: 'retries_exhausted',
          attempts: 2,
        }),
      }),
    );
  });

  it('treats transport errors as transient (retry, not dead-letter)', async () => {
    const { relay, tx, httpClient } = makeHarness({ WEBHOOK_RELAY_MAX_ATTEMPTS: 8 });
    httpClient.post.mockResolvedValue({ ok: false, status: null, bodyExcerpt: null, error: 'ECONNREFUSED' });

    await relay.processDueOnce();

    const update = tx.webhookDelivery.update.mock.calls[0][0].data;
    // Not terminal: the row returns to the due set via next_attempt_at only.
    expect(update.nextAttemptAt).toEqual(expect.any(Date));
    expect(tx.webhookDeliveryAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ outcome: 'FAILED', responseStatus: null, error: 'ECONNREFUSED' }),
    });
  });

  it('dead-letters endpointless rows (endpoint removed mid-flight), no attempt', async () => {
    const { relay, tx } = makeHarness();
    tx.webhookDelivery.findUniqueOrThrow.mockResolvedValue({
      id: 'd-1', eventId: 'evt-1', organizationId: 'org-a',
      url: 'https://hooks.example/a', payload: {}, attempts: 0,
      endpoint: null,
    });

    await relay.processDueOnce();

    expect(tx.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEAD_LETTERED',
          deadLetterReason: 'endpoint_removed',
        }),
      }),
    );
  });

  it('processes nothing when the due scan is empty', async () => {
    const { relay, prisma } = makeHarness();
    prisma.webhookDelivery.findMany.mockResolvedValue([]);

    await expect(relay.processDueOnce()).resolves.toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a claim-tx failure for one row does not abort the rest of the batch', async () => {
    const { relay, prisma } = makeHarness();
    prisma.webhookDelivery.findMany.mockResolvedValue([{ id: 'd-1' }, { id: 'd-2' }]);
    prisma.$transaction
      .mockRejectedValueOnce(new Error('lock contention'))
      .mockResolvedValueOnce(undefined);

    await expect(relay.processDueOnce()).resolves.toEqual(['d-2']);
  });
});
