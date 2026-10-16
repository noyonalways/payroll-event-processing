import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_STATUS_STREAM_CHANNEL, EventStatusNotification } from '@repo/shared';
import { PubSubService } from '@repo/database';
import { Response } from 'express';
import type { Request } from 'express';

/**
 * SSE headers for an unbounded stream (design D4): no proxy buffering, no
 * transformation, `Connection: keep-alive` — and `flushHeaders()` so the
 * TLS/proxy path sees the response before the first frame.
 */
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * One open SSE connection (design D1's per-connection registry entry).
 * `organizationId` comes from the verified access token and scopes every
 * frame this connection may ever receive.
 */
interface StreamClient {
  organizationId: string;
  /** ISO — when the connection opened, for error/log context. */
  openedAt: string;
  res: Response;
  heartbeat: NodeJS.Timeout;
}

/**
 * The in-process fan-out half of the event-status-stream (realtime-status
 * design D1): ONE shared Redis subscriber per API process routes pub/sub
 * messages to the open connections whose organization matches — twice
 * defensively (the dispatch registry routes by `organizationId`, and each
 * client re-checks the payload before a single byte is written), so another
 * tenant's transition is structurally undeliverable (tenancy R6).
 *
 * Delivery is fire-and-forget the same way publication is: a slow, broken, or
 * disconnected client tears down only its own connection — never the process,
 * the shared subscriber, or other subscribers. Nothing here is authoritative:
 * the committed `payroll_events` row remains the source of truth, and the read
 * endpoints are the resynchronization path.
 */
@Injectable()
export class EventStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventStreamService.name);
  private readonly clients = new Map<string, Set<StreamClient>>();
  private readonly heartbeatIntervalMs: number;
  private subscribed = false;

  constructor(
    private readonly pubsub: PubSubService,
    config: ConfigService,
  ) {
    // The same precedence `FailureConfig.fromEnv` documents: live
    // `process.env` wins over the ConfigService snapshot, because
    // `ConfigModule.forRoot` bakes its Joi-validated values once at import
    // time — a later (per-boot or per-test) `process.env` pin would never
    // reach the snapshot, and this knob is exactly the kind test suites pin
    // per boot to shorten the heartbeat window.
    const envInterval = Number(process.env.EVENT_STREAM_HEARTBEAT_INTERVAL_MS);
    this.heartbeatIntervalMs =
      Number.isFinite(envInterval) && envInterval >= 1
        ? envInterval
        : config.get<number>('EVENT_STREAM_HEARTBEAT_INTERVAL_MS', 15_000);
  }

  onModuleInit(): void {
    // ioredis re-issues established subscriptions across reconnects on its
    // own; this retry covers only the initial failure (Redis not yet up).
    void this.subscribeChannel();
    this.pubsub.subscriber.on('ready', () => {
      if (!this.subscribed) {
        void this.subscribeChannel();
      }
    });
    this.pubsub.subscriber.on('message', (channel, message) => {
      if (channel === EVENT_STATUS_STREAM_CHANNEL) {
        this.dispatch(message);
      }
    });
    this.logger.log('Event-status stream ready (Redis subscriber attached)');
  }

  private async subscribeChannel(): Promise<void> {
    try {
      await this.pubsub.subscriber.subscribe(EVENT_STATUS_STREAM_CHANNEL);
      this.subscribed = true;
    } catch (error) {
      // A down Redis must never crash the API; a later `ready` re-runs this.
      this.logger.error(
        `Event-status stream could not subscribe to ${EVENT_STATUS_STREAM_CHANNEL}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Opens an SSE connection for one authenticated organization: writes the
   * headers, starts the heartbeat, and registers the client for dispatch.
   * The connection lives until the client goes away (`close`) or the server
   * shuts down — teardown is full and silent, never an error path.
   */
  openStream(organizationId: string, req: Request, res: Response): void {
    res.status(200);
    res.set(SSE_HEADERS);
    // An immediate, inert byte: until the first chunk arrives, some proxies
    // hold the response open without telling the client the stream exists.
    // A socket that died even before this write never registered — its `close`
    // event is the only cleanup needed.
    try {
      res.write(': connected\n\n');
    } catch {
      // Ignore: the connection never made it open.
    }

    const client: StreamClient = {
      organizationId,
      openedAt: new Date().toISOString(),
      res,
      heartbeat: setInterval(() => {
        // SSE comment lines are inert to every conforming parser but keep the
        // path active — a liveness signal the client can time out against.
        this.writeClient(client, `: heartbeat ${new Date().toISOString()}\n\n`);
      }, this.heartbeatIntervalMs),
    };

    const orgClients = this.clients.get(organizationId) ?? new Set<StreamClient>();
    orgClients.add(client);
    this.clients.set(organizationId, orgClients);

    req.on('close', () => this.closeClient(organizationId, client, 'client disconnected'));
    this.logger.log(
      `Event-status stream opened for organization ${organizationId} at ${client.openedAt}`,
    );
  }

  /**
   * Routes one pub/sub message to its organization's open connections. A
   * malformed or foreign payload is dropped here first; the per-client
   * organization re-check is the second, structurally-final filter.
   */
  private dispatch(message: string): void {
    let notification: EventStatusNotification;
    try {
      notification = JSON.parse(message) as EventStatusNotification;
    } catch {
      this.logger.warn(
        `Event-status stream dropped an undecodable message (${message.length} bytes)`,
      );
      return;
    }
    if (typeof notification?.organizationId !== 'string' || typeof notification?.eventId !== 'string') {
      this.logger.warn('Event-status stream dropped a message without an organization/event id');
      return;
    }

    for (const client of this.clients.get(notification.organizationId) ?? []) {
      // Second, final tenancy filter (R6): the registry route above is by
      // organization, but this connection will not emit a frame until the
      // payload itself names ITS organization.
      if (client.organizationId !== notification.organizationId) {
        continue;
      }
      // The forwarded body is the raw message — already validated JSON.
      this.writeClient(client, `event: lifecycle\ndata: ${message}\n\n`);
    }
  }

  /** One guarded write: any failure tears only this connection down. */
  private writeClient(client: StreamClient, frame: string): void {
    try {
      client.res.write(frame);
    } catch (error) {
      this.logger.debug(
        `Stream write failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.closeClient(client.organizationId, client, 'write failed');
    }
  }

  private closeClient(organizationId: string, client: StreamClient, reason: string): void {
    clearInterval(client.heartbeat);
    const orgClients = this.clients.get(organizationId);
    if (orgClients) {
      orgClients.delete(client);
      if (orgClients.size === 0) {
        this.clients.delete(organizationId);
      }
    }
    try {
      client.res.end();
    } catch {
      // Already gone — teardown stays silent.
    }
    this.logger.log(
      `Event-status stream closed for organization ${organizationId} (${reason}, opened at ${client.openedAt})`,
    );
  }

  /** Server shutdown: every open stream ends cleanly, with no error frame. */
  onModuleDestroy(): void {
    for (const [organizationId, orgClients] of [...this.clients.entries()]) {
      for (const client of [...orgClients]) {
        this.closeClient(organizationId, client, 'server shutdown');
      }
    }
  }
}
