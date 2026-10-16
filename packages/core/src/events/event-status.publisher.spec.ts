import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EVENT_STATUS_STREAM_CHANNEL, EventType } from '@repo/shared';
import { PubSubService } from '@repo/database';
import { EventStatusPublisher } from './event-status.publisher';
import type { EventStatusNotification } from '@repo/shared';

const notification = (overrides: Partial<EventStatusNotification> = {}): EventStatusNotification => ({
  organizationId: 'org-a',
  eventId: 'evt-1',
  eventType: EventType.BANK_ACCOUNT_CHANGE,
  employeeId: 'emp-1',
  sequence: 3,
  status: 'queued',
  occurredAt: '2026-10-16T10:00:00.000Z',
  ...overrides,
});

/** Lets the discarded fire-and-forget promise settle before asserting. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('EventStatusPublisher', () => {
  let publisher: EventStatusPublisher;
  const pubsub = { publisher: { publish: jest.fn() } };
  let loggerError: jest.SpyInstance;
  let loggerVerbose: jest.SpyInstance;

  beforeEach(async () => {
    jest.clearAllMocks();
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    loggerVerbose = jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => {});

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EventStatusPublisher,
        { provide: PubSubService, useValue: pubsub },
      ],
    }).compile();

    publisher = moduleRef.get<EventStatusPublisher>(EventStatusPublisher);
  });

  afterEach(() => {
    loggerError.mockRestore();
    loggerVerbose.mockRestore();
  });

  it('publishes the JSON-serialized notification on the stream channel', async () => {
    pubsub.publisher.publish.mockResolvedValue(1);

    publisher.publish(notification());
    await settle();

    expect(pubsub.publisher.publish).toHaveBeenCalledTimes(1);
    expect(pubsub.publisher.publish).toHaveBeenCalledWith(
      EVENT_STATUS_STREAM_CHANNEL,
      JSON.stringify(notification()),
    );
  });

  it('returns without awaiting the send — a slow Redis cannot delay a committing operation', async () => {
    // The client's publish never resolves; the fire-and-forget call must
    // return immediately regardless.
    pubsub.publisher.publish.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    const result = publisher.publish(notification());
    expect(Date.now() - started).toBeLessThan(50);
    expect(result).toBeUndefined();

    await settle();
    expect(pubsub.publisher.publish).toHaveBeenCalledTimes(1);
  });

  it('swallows and logs a Redis failure — the publish path never rethrows', async () => {
    pubsub.publisher.publish.mockRejectedValue(
      new Error('ECONNREFUSED 127.0.0.1:6379'),
    );

    expect(() => publisher.publish(notification())).not.toThrow();
    await settle();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Event-status stream publish failed for event evt-1'),
    );
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('organization org-a'),
    );
  });

  it('even a synchronous client failure is swallowed by the same guard', async () => {
    pubsub.publisher.publish.mockClear();
    jest
      .spyOn(pubsub.publisher, 'publish')
      .mockImplementation(() => {
        throw new Error('sync failure');
      }) as unknown as jest.SpyInstance;

    expect(() => publisher.publish(notification())).not.toThrow();
    await settle();
    expect(loggerError).toHaveBeenCalled();
  });
});
