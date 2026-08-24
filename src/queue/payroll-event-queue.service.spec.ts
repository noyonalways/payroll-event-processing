import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { PayrollEventQueueService } from './payroll-event-queue.service';
import { PAYROLL_EVENTS_QUEUE, PAYROLL_EVENT_JOB } from './queue.constants';
import { EventType } from '../events/event-type';

describe('PayrollEventQueueService', () => {
  let service: PayrollEventQueueService;

  const queue = {
    add: jest.fn(),
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PayrollEventQueueService,
        { provide: getQueueToken(PAYROLL_EVENTS_QUEUE), useValue: queue },
      ],
    }).compile();

    service = moduleRef.get<PayrollEventQueueService>(PayrollEventQueueService);
  });

  describe('enqueue (per-employee FIFO producer)', () => {
    it('adds the job keyed by employeeId with the FIFO/retention options', async () => {
      queue.add.mockResolvedValue({ id: 'emp-1' });

      await service.enqueue({
        eventId: 'evt-1',
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 3,
      });

      expect(queue.add).toHaveBeenCalledWith(
        PAYROLL_EVENT_JOB,
        expect.objectContaining({
          eventId: 'evt-1',
          eventType: EventType.BANK_ACCOUNT_CHANGE,
          employeeId: 'emp-1',
          sequence: 3, // JSON-safe — the caller converts bigint → Number
        }),
        {
          // jobId = employeeId: BullMQ short-circuits an add whose jobId exists,
          // so at most one job per employee is in flight (design D2).
          jobId: 'emp-1',
          attempts: 1,
          // Completed/failed jobs are freed so the SAME jobId can be re-added by
          // the worker's relay — a retained completed job would suppress it and
          // starve the FIFO (design D5).
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
    });

    it('a suppressed duplicate (existing jobId) resolves as a silent no-op', async () => {
      // addStandardJob short-circuits when the jobId key already exists
      // (wait/active) and returns the existing job — no throw, no second job.
      queue.add.mockResolvedValue({ id: 'emp-1' });

      await expect(
        service.enqueue({
          eventId: 'evt-dup',
          eventType: EventType.ADDRESS_CHANGE,
          employeeId: 'emp-1',
          sequence: 2,
        }),
      ).resolves.toBeUndefined();

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('converts bigint sequences to JSON-safe numbers', async () => {
      queue.add.mockResolvedValue({ id: 'emp-2' });

      await service.enqueue({
        eventId: 'evt-2',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-2',
        sequence: 1,
      });

      const data = queue.add.mock.calls[0][1] as Record<string, unknown>;
      expect(data.sequence).toBe(1);
      expect(typeof data.sequence).toBe('number');
    });
  });

  describe('lifecycle', () => {
    it('subscribes to Redis connection errors so they never go unhandled', () => {
      expect(queue.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('closes the queue on module destroy', async () => {
      await service.onModuleDestroy();
      expect(queue.close).toHaveBeenCalledTimes(1);
    });
  });
});