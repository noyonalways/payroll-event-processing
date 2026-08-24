import { PayrollEventProcessor } from './payroll-event.processor';
import { PrismaService } from '../../../src/prisma/prisma.service';
import { PayrollEventQueueService } from '../../../src/queue/payroll-event-queue.service';
import { PAYROLL_EVENT_JOB } from '../../../src/queue/queue.constants';
import { EventStatus } from '@prisma/client';
import { EventType } from '../../../src/events/event-type';
import { ProcessingResult } from '../../../src/processing/processing.types';
import { HandlerRegistry } from '../../../src/processing/handler-registry';
import { TransientPayrollFailureError } from '../../../src/processing/errors/payroll-processing.error';

/**
 * Direct-instantiation unit tests. The processor must not touch `WorkerHost.worker`
 * at construction (BullRegistrar only populates it during Nest's onModuleInit), so
 * `new PayrollEventProcessor(prisma, queueService, registry)` below is safe in
 * isolation.
 *
 * FIFO continuation is driven by the BullMQ `completed` event (NOT from inside
 * `process()` — while `process()` runs the job is still active and its own
 * `jobId = employeeId` would suppress the relay's add). Tests therefore call
 * `processor.onCompleted(job)` for the relay assertions.
 */
describe('PayrollEventProcessor', () => {
  let processor: PayrollEventProcessor;

  const prisma = {
    payrollEvent: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
  };
  const queueService = { enqueue: jest.fn() };
  const registry = { resolve: jest.fn() };

  const successResult: ProcessingResult = {
    reference: 'SIM-test-ref',
    employeeId: 'emp-1',
    effectiveDate: '2026-09-01',
    acknowledged: { iban: 'DE89370400440532013000' },
  };

  const stubStrategy = (behavior: 'success' | 'fail') => ({
    handle: jest.fn(async () => {
      if (behavior === 'fail') {
        throw new TransientPayrollFailureError('simulated down');
      }
      return successResult;
    }),
  });

  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      name: PAYROLL_EVENT_JOB,
      data: {
        eventId: 'evt-1',
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
        ...overrides,
      },
    }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new PayrollEventProcessor(
      prisma as unknown as PrismaService,
      queueService as unknown as PayrollEventQueueService,
      registry as unknown as HandlerRegistry,
    );
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollEvent.findUnique.mockResolvedValue({
      payload: successResult.acknowledged,
    });
    prisma.payrollEvent.findFirst.mockResolvedValue(null);
    queueService.enqueue.mockResolvedValue(undefined);
  });

  describe('claim → dispatch → success lifecycle', () => {
    beforeEach(() => {
      registry.resolve.mockReturnValue(stubStrategy('success'));
    });

    it('claims, dispatches via the registry, and stores the result with processed_at', async () => {
      await processor.process(job());

      expect(prisma.payrollEvent.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'evt-1', status: EventStatus.RECEIVED },
        data: { status: EventStatus.QUEUED },
      });
      expect(prisma.payrollEvent.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'evt-1', status: EventStatus.QUEUED },
        data: { status: EventStatus.PROCESSING },
      });

      expect(prisma.payrollEvent.findUnique).toHaveBeenCalledWith({
        where: { id: 'evt-1' },
        select: { payload: true },
      });
      expect(registry.resolve).toHaveBeenCalledWith(EventType.BANK_ACCOUNT_CHANGE);

      expect(prisma.payrollEvent.updateMany).toHaveBeenNthCalledWith(3, {
        where: { id: 'evt-1', status: EventStatus.PROCESSING },
        data: {
          status: EventStatus.SUCCESS,
          processedAt: expect.any(Date),
          result: successResult,
        },
      });
    });
  });

  describe('handler failure lifecycle', () => {
    beforeEach(() => {
      registry.resolve.mockReturnValue(stubStrategy('fail'));
    });

    it('transitions to failed with no result and does not re-enqueue', async () => {
      await processor.process(job());

      expect(prisma.payrollEvent.updateMany).toHaveBeenNthCalledWith(3, {
        where: { id: 'evt-1', status: EventStatus.PROCESSING },
        data: { status: EventStatus.FAILED },
      });
      // Exactly the 3 guarded updates — the success write never happens.
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(3);
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('stale / duplicate job', () => {
    it('skips a job whose row is not queued and never invokes a handler', async () => {
      prisma.payrollEvent.updateMany
        .mockResolvedValueOnce({ count: 0 }) // received → queued: no match
        .mockResolvedValueOnce({ count: 0 }); // queued → processing: no match

      await processor.process(job());

      // No terminal update, no payload read, no handler, no relay.
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.payrollEvent.findUnique).not.toHaveBeenCalled();
      expect(registry.resolve).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.findFirst).not.toHaveBeenCalled();
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });

    it('never double-applies: a crash-then-reprocess cannot succeed twice', async () => {
      // Terminal update already applied (row already SUCCESS) → claim fails.
      prisma.payrollEvent.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      await processor.process(job());

      const terminal = prisma.payrollEvent.updateMany.mock.calls[2];
      expect(terminal).toBeUndefined();
    });
  });

  describe('FIFO relay (completion-driven)', () => {
    it('relays the next pending event in sequence order once the job completes', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue({
        id: 'evt-2',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
        sequence: 2n, // DB returns bigint for sequence
      });

      await processor.onCompleted(job());

      expect(prisma.payrollEvent.findFirst).toHaveBeenCalledWith({
        where: {
          employeeId: 'emp-1',
          id: { not: 'evt-1' },
          status: { in: [EventStatus.RECEIVED, EventStatus.QUEUED] },
        },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          eventType: true,
          employeeId: true,
          sequence: true,
        },
      });
      expect(queueService.enqueue).toHaveBeenCalledWith({
        eventId: 'evt-2',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-1',
        sequence: 2, // Number(bigint) — JSON-safe job payload
      });
    });

    it('skips terminal rows when selecting the next pending event', async () => {
      // Both rows already success/failed → nothing to relay.
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await processor.onCompleted(job());

      expect(queueService.enqueue).not.toHaveBeenCalled();
    });

    it('relays the employee of the completed job, never another employee', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue({
        id: 'evt-2',
        eventType: EventType.ADDRESS_CHANGE,
        employeeId: 'emp-2',
        sequence: 1n,
      });

      await processor.onCompleted(job());

      expect(prisma.payrollEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ employeeId: 'emp-1' }),
        }),
      );
    });

    it('a failed relay never fails (throws) the completion handler', async () => {
      prisma.payrollEvent.findFirst.mockRejectedValue(new Error('connection reset'));

      await expect(processor.onCompleted(job())).resolves.toBeUndefined();
      expect(queueService.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle', () => {
    it('closes cleanly even when the worker was never initialized (unit isolation)', async () => {
      // Direct `new` (no Nest bootstrap) → _worker never set; close must not throw.
      await expect(processor.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});