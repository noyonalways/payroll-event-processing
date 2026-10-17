import { WebhookOutboxWriter } from './webhook-outbox.writer';

/**
 * Unit coverage for the transactional outbox writer (integrator-webhooks
 * design D3, verified against the mock-tx convention used by event-claim.spec).
 * The writer receives the LIVE claim transaction client — the mocks assert it
 * performs its endpoint lookup and delivery inserts THROUGH that client, so a
 * caller's commit/rollback sweeps the intents with it.
 */
describe('WebhookOutboxWriter', () => {
  const writer = new WebhookOutboxWriter();

  const notification = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'evt-1',
    organizationId: 'org-a',
    employeeId: 'emp-1',
    eventType: 'BANK_ACCOUNT_CHANGE',
    sequence: 7,
    status: 'SUCCESS' as const,
    result: { reference: 'ref-1' },
    occurredAt: '2026-10-16T09:00:00.000Z',
    ...overrides,
  });

  const makeTx = () => ({
    webhookEndpoint: { findMany: jest.fn() },
    webhookDelivery: {
      create: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
  });

  it('writes one pending delivery per active endpoint, inside the caller tx', async () => {
    const tx = makeTx();
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', url: 'https://hooks.example/a' },
      { id: 'ep-2', url: 'https://hooks.example/b' },
    ]);

    await writer.write(tx as never, notification());

    // Endpoints are read through the LIVE transaction client.
    expect(tx.webhookEndpoint.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', active: true },
      select: { id: true, url: true },
    });
    expect(tx.webhookDelivery.create).toHaveBeenCalledTimes(2);
    const [first] = tx.webhookDelivery.create.mock.calls[0][0].data
      ? [tx.webhookDelivery.create.mock.calls[0][0].data]
      : [];
    expect(first).toMatchObject({
      organizationId: 'org-a',
      webhookEndpointId: 'ep-1',
      eventId: 'evt-1',
      terminalStatus: 'SUCCESS',
      url: 'https://hooks.example/a',
      status: 'PENDING',
      attempts: 0,
    });

    // The pre-rendered payload snapshot is stamped per delivery row (with its id).
    expect(tx.webhookDelivery.update).toHaveBeenCalledTimes(2);
    const payloadCall = tx.webhookDelivery.update.mock.calls[0][0];
    expect(payloadCall.where).toEqual({ id: 'delivery-1' });
    expect(payloadCall.data.payload).toMatchObject({
      eventId: 'evt-1',
      organizationId: 'org-a',
      employeeId: 'emp-1',
      eventType: 'BANK_ACCOUNT_CHANGE',
      sequence: 7,
      status: 'SUCCESS',
      result: { reference: 'ref-1' },
      failedReason: null,
      occurredAt: '2026-10-16T09:00:00.000Z',
      deliveryId: 'delivery-1',
    });
  });

  it('is a no-op when the organization has no active endpoints', async () => {
    const tx = makeTx();
    tx.webhookEndpoint.findMany.mockResolvedValue([]);

    await writer.write(tx as never, notification());

    expect(tx.webhookDelivery.create).not.toHaveBeenCalled();
    expect(tx.webhookDelivery.update).not.toHaveBeenCalled();
  });

  it('renders FAILED notifications with the failure reason and no result', async () => {
    const tx = makeTx();
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', url: 'https://hooks.example/a' },
    ]);

    await writer.write(
      tx as never,
      notification({
        status: 'FAILED',
        failedReason: 'business rejection',
        result: undefined,
      }),
    );

    const payload = tx.webhookDelivery.update.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({
      status: 'FAILED',
      failedReason: 'business rejection',
      result: null,
    });
  });

  it('renders CANCELLED notifications with no result and no reason', async () => {
    const tx = makeTx();
    tx.webhookEndpoint.findMany.mockResolvedValue([
      { id: 'ep-1', url: 'https://hooks.example/a' },
    ]);

    await writer.write(
      tx as never,
      notification({ status: 'CANCELLED', result: undefined }),
    );

    const payload = tx.webhookDelivery.update.mock.calls[0][0].data.payload;
    expect(payload).toMatchObject({ status: 'CANCELLED', result: null, failedReason: null });
  });
});
