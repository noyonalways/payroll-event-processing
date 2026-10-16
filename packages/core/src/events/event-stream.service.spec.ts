import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter } from 'events';
import type { Request, Response } from 'express';
import { EVENT_STATUS_STREAM_CHANNEL } from '@repo/shared';
import { PubSubService } from '@repo/database';
import { EventStreamService } from './event-stream.service';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

const notification = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    organizationId: ORG_A,
    eventId: 'evt-1',
    eventType: 'BANK_ACCOUNT_CHANGE',
    employeeId: 'emp-1',
    sequence: 1,
    status: 'success',
    occurredAt: '2026-10-16T10:00:00.000Z',
    ...overrides,
  });

/** A minimal but behavioral Express response pair for stream assertions. */
const connection = () => {
  const req = new EventEmitter() as EventEmitter & Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(),
  } as unknown as Response & { write: jest.Mock; end: jest.Mock };
  return { req, res };
};

/** Harness: real service, mocked Redis pub/sub and fake-timer heartbeats. */
const harness = (heartbeatIntervalMs = 15_000) => {
  const subscriber = new EventEmitter() as EventEmitter & {
    subscribe: jest.Mock;
  };
  subscriber.subscribe = jest.fn().mockResolvedValue(1);
  const pubsub = {
    subscriber,
    publisher: { publish: jest.fn() },
  } as unknown as PubSubService;
  const config = {
    get: (_key: string, defaultValue?: unknown) =>
      _key === 'EVENT_STREAM_HEARTBEAT_INTERVAL_MS' ? heartbeatIntervalMs : defaultValue,
  } as unknown as ConfigService;
  const service = new EventStreamService(pubsub, config);
  return { service, subscriber };
};

describe('EventStreamService', () => {
  let loggerError: jest.SpyInstance;
  let loggerWarn: jest.SpyInstance;
  let loggerLog: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    loggerLog = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    loggerError.mockRestore();
    loggerWarn.mockRestore();
    loggerLog.mockRestore();
  });

  it('onModuleInit subscribes the process-side connection to the stream channel', async () => {
    const { service, subscriber } = harness();
    service.onModuleInit();
    // The (void) subscribe is awaited asynchronously — flush one tick.
    await Promise.resolve();

    expect(subscriber.subscribe).toHaveBeenCalledWith(EVENT_STATUS_STREAM_CHANNEL);
  });

  it('logs and continues when the initial subscribe fails (a later ready retries)', async () => {
    const { service, subscriber } = harness();
    subscriber.subscribe.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    service.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('could not subscribe'),
    );

    // Redis comes back: the `ready` handler re-attempts the subscription.
    subscriber.subscribe.mockResolvedValue(1);
    subscriber.emit('ready');
    await Promise.resolve();
    await Promise.resolve();

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  it('routes a committed transition only to the named organization’s connections', async () => {
    const { service, subscriber } = harness();
    service.onModuleInit();
    const a1 = connection();
    const a2 = connection();
    const b1 = connection();
    service.openStream(ORG_A, a1.req, a1.res);
    service.openStream(ORG_A, a2.req, a2.res);
    service.openStream(ORG_B, b1.req, b1.res);

    // Emit exactly the way the real pub/sub subscriber does.
    const message = notification();
    subscriber.emit('message', EVENT_STATUS_STREAM_CHANNEL, message);

    expect(a1.res.write).toHaveBeenCalledWith(
      `event: lifecycle\ndata: ${message}\n\n`,
    );
    expect(a2.res.write).toHaveBeenCalledWith(
      `event: lifecycle\ndata: ${message}\n\n`,
    );
    expect(b1.res.write).not.toHaveBeenCalledWith(
      expect.stringContaining('event: lifecycle'),
    );
  });

  it('drops undecodable payloads and messages without an identity (defensive filter)', async () => {
    const { service, subscriber } = harness();
    service.onModuleInit();
    const { req, res } = connection();
    service.openStream(ORG_A, req, res);
    const goodFrames = res.write.mock.calls.filter((c) =>
      String(c[0]).startsWith('event:'),
    ).length;

    subscriber.emit('message', EVENT_STATUS_STREAM_CHANNEL, 'not json at all');
    subscriber.emit('message', EVENT_STATUS_STREAM_CHANNEL, JSON.stringify({ status: 'success' }));
    subscriber.emit('message', 'another-channel', notification());

    const goodFramesNow = res.write.mock.calls.filter((c) =>
      String(c[0]).startsWith('event:'),
    ).length;
    expect(goodFramesNow).toBe(goodFrames);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('dropped an undecodable message'),
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('dropped a message without'),
    );
  });

  it('the per-client organization re-check never relays a foreign payload', async () => {
    const { service } = harness();
    const { req, res } = connection();
    service.openStream(ORG_A, req, res);

    // A corrupted message names ANOTHER organization — the registry routed it
    // nowhere anyway, and even a direct dispatch to org-a's set must not write
    // a payload that does not name org-a.
    (service as unknown as { dispatch(message: string): void }).dispatch(
      notification({ organizationId: ORG_B }),
    );

    expect(res.write).not.toHaveBeenCalledWith(
      expect.stringContaining('event: lifecycle'),
    );
  });

  it('a write failure tears down only that connection', async () => {
    const { service, subscriber } = harness();
    service.onModuleInit();
    const broken = connection();
    const healthy = connection();
    broken.res.write.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    service.openStream(ORG_A, broken.req, broken.res);
    service.openStream(ORG_A, healthy.req, healthy.res);

    // The initial `: connected` comment already threw for the broken client
    // (its write throws synchronously); the teardown happens client-scoped:
    // the healthy connection still receives the next transition.
    subscriber.emit('message', EVENT_STATUS_STREAM_CHANNEL, notification());

    expect(healthy.res.write).toHaveBeenCalledWith(
      expect.stringContaining('event: lifecycle'),
    );
    expect(broken.res.end).toHaveBeenCalled();
  });

  it('keeps an idle connection alive with heartbeat comment lines at the configured interval', () => {
    const { service } = harness(5_000);
    const { req, res } = connection();
    service.openStream(ORG_A, req, res);

    jest.advanceTimersByTime(15_000);

    const heartbeats = res.write.mock.calls
      .map((c) => String(c[0]))
      .filter((frame) => frame.startsWith(': heartbeat'));
    expect(heartbeats.length).toBe(3); // t=5s, 10s, 15s
  });

  it('client disconnect cleans up silently: no frames, no further writes, registry emptied', async () => {
    const { service, subscriber } = harness();
    const { req, res } = connection();
    service.openStream(ORG_A, req, res);

    req.emit('close');

    subscriber.emit('message', EVENT_STATUS_STREAM_CHANNEL, notification());
    const framesAfterClose = res.write.mock.calls.filter((c) =>
      String(c[0]).startsWith('event:'),
    );
    expect(framesAfterClose).toHaveLength(0);
    expect(res.end).toHaveBeenCalled();
    service.onModuleDestroy(); // registry already empty; must not throw
  });

  it('onModuleDestroy ends every open stream cleanly (server shutdown)', () => {
    const { service } = harness();
    const a = connection();
    const b = connection();
    service.openStream(ORG_A, a.req, a.res);
    service.openStream(ORG_B, b.req, b.res);

    service.onModuleDestroy();

    expect(a.res.end).toHaveBeenCalled();
    expect(b.res.end).toHaveBeenCalled();
  });
});
