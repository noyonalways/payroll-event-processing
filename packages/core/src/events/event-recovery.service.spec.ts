import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventStatus } from '@prisma/client';
import { EventRecoveryService } from './event-recovery.service';
import { EventStatusPublisher } from './event-status.publisher';
import { PrismaService } from '@repo/database';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { WebhookOutboxWriter } from '../webhooks/webhook-outbox.writer';
import { MetricsService } from '../telemetry/metrics.service';
import { EventType } from '@repo/shared';

const ORG = 'org-a';

/**
 * Direct unit tests for the manual recovery actions (event-recovery design
 * D2/D3/D5/D6). The guarded transition + audit row run in ONE interactive
 * transaction — the mock replay runs the callback against the same mock (the
 * tx client IS the PrismaService mock), and each test asserts the guarded
 * `updateMany`, the audit `create`, and the post-commit enqueue as separate
 * writes. Concurrency is modelled the way Postgres behaves: the second action's
 * guarded update matches 0 rows and the transaction throws 409 with nothing
 * recorded.
 */
describe('EventRecoveryService', () => {
  let service: EventRecoveryService;

  const prisma = {
    payrollEvent: { findFirst: jest.fn(), updateMany: jest.fn() },
    eventAttempt: { aggregate: jest.fn() },
    eventAction: { create: jest.fn() },
    // The outbox writer reads active endpoints through the LIVE tx client —
    // which IS this mock (the interactive tx reuses it by convention here).
    webhookEndpoint: { findMany: jest.fn() },
    $transaction: jest.fn(),
  };
  const eventQueue = { enqueueBestEffort: jest.fn() };
  const streamPublisher = { publish: jest.fn() };
  const webhookOutbox = { write: jest.fn().mockResolvedValue(undefined) };
  const metrics = { recordTerminal: jest.fn(), recordAttempt: jest.fn() };

  const failedRow = {
    id: 'evt-1',
    eventType: EventType.SALARY_CHANGE,
    employeeId: 'emp-1',
    sequence: 3n,
    status: EventStatus.FAILED,
  };
  const queuedRow = { ...failedRow, status: EventStatus.QUEUED };

  /** The interactive transaction runs its callback against the same mock. */
  const interactiveTx = () => {
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
      fn(prisma),
    );
  };

  /** The guarded update matched 0 rows — another action won the race. */
  const concurrentLoser = () => {
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 0 });
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EventRecoveryService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayrollEventQueueService, useValue: eventQueue },
        { provide: EventStatusPublisher, useValue: streamPublisher },
        { provide: WebhookOutboxWriter, useValue: webhookOutbox },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = moduleRef.get<EventRecoveryService>(EventRecoveryService);
    prisma.payrollEvent.findFirst.mockReset();
    prisma.payrollEvent.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prisma.eventAttempt.aggregate.mockReset().mockResolvedValue({ _max: { attemptNumber: 2 } });
    prisma.webhookEndpoint.findMany.mockReset().mockResolvedValue([]);
    webhookOutbox.write.mockReset().mockResolvedValue(undefined);
    prisma.eventAction.create.mockReset().mockResolvedValue({ id: 'audit-1' });
    prisma.$transaction.mockReset();
    interactiveTx();
    eventQueue.enqueueBestEffort.mockReset().mockResolvedValue(undefined);
  });

  describe('retryEvent (failed → queued, one guarded transaction)', () => {
    it('transitions the failed row, sets attempt_base to the trail length, audits, and enqueues', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(failedRow);

      const result = await service.retryEvent(ORG, 'evt-1', 'user-1');

      expect(result).toEqual({
        id: 'evt-1',
        status: 'queued',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
      });

      // The guarded transition: only a FAILED row moves, to QUEUED, with the
      // round base = MAX(attempt_number) recorded by earlier rounds (D4).
      expect(prisma.eventAttempt.aggregate).toHaveBeenCalledWith({
        _max: { attemptNumber: true },
        where: { eventId: 'evt-1' },
      });
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', organizationId: ORG, status: EventStatus.FAILED },
        data: { status: EventStatus.QUEUED, attemptBase: 2 },
      });

      // The RETRY audit row rides the same transaction, naming the actor.
      expect(prisma.eventAction.create).toHaveBeenCalledWith({
        data: { eventId: 'evt-1', action: 'RETRY', userId: 'user-1' },
      });

      // Post-commit stream announcement (realtime-status): the committed
      // `queued` transition is announced fire-and-forget with full identity.
      expect(streamPublisher.publish).toHaveBeenCalledWith({
        organizationId: ORG,
        eventId: 'evt-1',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
        status: 'queued',
        occurredAt: expect.any(String),
      });

      // Post-commit best-effort enqueue, carrying identity AND the round base
      // so the fresh job numbers its attempts after the recorded trail.
      expect(eventQueue.enqueueBestEffort).toHaveBeenCalledWith({
        eventId: 'evt-1',
        organizationId: ORG,
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
        attemptBase: 2,
      });
    });

    it('hands a zero round base to a first-round retry (no trail yet)', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(failedRow);
      prisma.eventAttempt.aggregate.mockResolvedValue({ _max: { attemptNumber: null } });

      await service.retryEvent(ORG, 'evt-1', 'user-1');

      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: EventStatus.QUEUED, attemptBase: 0 },
        }),
      );
      expect(eventQueue.enqueueBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ attemptBase: 0 }),
      );
    });

    it('404s an unknown id (and an id of another organization) without writing anything', async () => {
      // findFirst is (id, organization)-scoped: a foreign event reads as absent.
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await expect(service.retryEvent(ORG, 'evt-foreign', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
      expect(streamPublisher.publish).not.toHaveBeenCalled();
    });

    it('409s a non-failed event — queued, success, cancelled, received — and leaves it unchanged', async () => {
      for (const status of [
        EventStatus.QUEUED,
        EventStatus.RECEIVED,
        EventStatus.SUCCESS,
        EventStatus.PROCESSING,
        EventStatus.CANCELLED,
      ]) {
        prisma.payrollEvent.findFirst.mockResolvedValue({ ...failedRow, status });

        await expect(service.retryEvent(ORG, 'evt-1', 'user-1')).rejects.toBeInstanceOf(
          ConflictException,
        );
      }

      // Not a single transition or audit row for the five rejections.
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
    });

    it('the concurrent loser of a retry 409s and records nothing (guard matched 0 rows)', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(failedRow);
      concurrentLoser();

      await expect(service.retryEvent(ORG, 'evt-1', 'user-1')).rejects.toBeInstanceOf(
        ConflictException,
      );

      // The audit row is INSIDE the transaction whose guard matched nothing —
      // the rollback means no audit row exists for the rejected call (D6),
      // and the publish after the transaction never runs.
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
      expect(streamPublisher.publish).not.toHaveBeenCalled();
    });

    it('still resolves when the queue is unreachable (best-effort enqueue)', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(failedRow);
      eventQueue.enqueueBestEffort.mockRejectedValue(new Error('Connection is closed.'));

      const result = await service.retryEvent(ORG, 'evt-1', 'user-1');

      // The guarded transition already committed — the action is applied and
      // the employee's relay recovers the enqueue.
      expect(result.status).toBe('queued');
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelEvent (received|queued → cancelled, one guarded transaction)', () => {
    it('transitions a queued row, audits the actor, and never touches the queue', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(queuedRow);

      const result = await service.cancelEvent(ORG, 'evt-1', 'user-1');

      expect(result).toEqual({
        id: 'evt-1',
        status: 'cancelled',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
      });
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'evt-1',
          organizationId: ORG,
          status: { in: [EventStatus.RECEIVED, EventStatus.QUEUED] },
        },
        data: { status: EventStatus.CANCELLED },
      });
      expect(prisma.eventAction.create).toHaveBeenCalledWith({
        data: { eventId: 'evt-1', action: 'CANCEL', userId: 'user-1' },
      });
      // A cancel is pure state: no job add, no removal — the guarded claim
      // makes any surfaced job a no-op (design D5).
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
      // Post-commit stream announcement (realtime-status): the terminal
      // `cancelled` state is announced with the row identity.
      expect(streamPublisher.publish).toHaveBeenCalledWith({
        organizationId: ORG,
        eventId: 'evt-1',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
        status: 'cancelled',
        occurredAt: expect.any(String),
      });
    });

    it('cancels a stranded received row', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue({
        ...failedRow,
        status: EventStatus.RECEIVED,
      });

      const result = await service.cancelEvent(ORG, 'evt-1', 'user-1');

      expect(result.status).toBe('cancelled');
      expect(prisma.eventAction.create).toHaveBeenCalledWith({
        data: { eventId: 'evt-1', action: 'CANCEL', userId: 'user-1' },
      });
    });

    it('writes a CANCELLED webhook intent inside the cancel transaction (integrator-webhooks)', async () => {
      interactiveTx();
      prisma.payrollEvent.findFirst.mockResolvedValue(queuedRow);
      prisma.webhookEndpoint.findMany.mockResolvedValue([
        { id: 'ep-1', url: 'https://hooks.example/a' },
      ]);

      await service.cancelEvent(ORG, 'evt-1', 'user-1');

      expect(webhookOutbox.write).toHaveBeenCalledTimes(1);
      const [txArg, notification] = webhookOutbox.write.mock.calls[0];
      expect(txArg).toBe(prisma as unknown);
      expect(notification).toMatchObject({
        eventId: 'evt-1',
        organizationId: ORG,
        employeeId: 'emp-1',
        eventType: EventType.SALARY_CHANGE,
        sequence: 3,
        status: 'CANCELLED',
      });
      expect(notification.result).toBeUndefined();
      expect(notification.failedReason).toBeUndefined();
    });

    it('404s an unknown or foreign id without writing anything', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await expect(service.cancelEvent(ORG, 'evt-foreign', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
    });

    it('409s terminal and in-flight events — success, failed, cancelled, processing', async () => {
      for (const status of [
        EventStatus.SUCCESS,
        EventStatus.FAILED,
        EventStatus.CANCELLED,
        EventStatus.PROCESSING,
      ]) {
        prisma.payrollEvent.findFirst.mockResolvedValue({ ...failedRow, status });

        await expect(service.cancelEvent(ORG, 'evt-1', 'user-1')).rejects.toBeInstanceOf(
          ConflictException,
        );
      }

      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
    });

    it('the concurrent loser of a cancel 409s and records nothing', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(queuedRow);
      concurrentLoser();

      await expect(service.cancelEvent(ORG, 'evt-1', 'user-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.eventAction.create).not.toHaveBeenCalled();
    });
  });
});
