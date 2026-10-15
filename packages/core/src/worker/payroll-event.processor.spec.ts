import { PayrollEventProcessor } from './payroll-event.processor';
import { PrismaService } from '@repo/database';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { PAYROLL_EVENT_JOB, EventType, TransientPayrollFailureError } from '@repo/shared';
import { EventStatus } from '@prisma/client';
import { EventClaim } from '../processing/event-claim';
import { HeartbeatService } from '../processing/heartbeat.service';
import { ConfigService } from '@nestjs/config';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

/**
 * Direct-instantiation unit tests. The processor must not touch `WorkerHost.worker`
 * at construction (BullRegistrar only populates it during Nest's onModuleInit), so
 * `new PayrollEventProcessor(prisma, queueService, config, eventClaim, heartbeat)`
 * below is safe in isolation.
 *
 * The claim → dispatch → terminal-write lifecycle is DELEGATED to `EventClaim`
 * (#7, design D1): everything the processor itself must verify is the received →
 * queued ensure staying OUTSIDE the transaction, the heartbeat touch, the
 * claimAndProcess delegation, the outcome-driven structured log lines, and the
 * exhausted-retry `$transaction([...])` in onFailed. The transactional contract
 * itself (claim/commit order, skip, rollback-on-transient) is covered in
 * `event-claim.spec.ts`.
 *
 * FIFO continuation is driven by the BullMQ `completed` event (NOT from inside
 * `process()` — while `process()` runs the job is still active and its own
 * tenant-qualified `jobId` would suppress the relay's add). Tests therefore call
 * `processor.onCompleted(job)` for the relay assertions.
 *
 * Every statement is scoped by the organization carried in the job data, so the
 * processor can only ever touch rows belonging to the tenant the producer
 * enqueued the job for.
 */
describe('PayrollEventProcessor', () => {
  let processor: PayrollEventProcessor;

  const prisma = {
    payrollEvent: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    eventAttempt: { create: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  const queueService = { enqueue: jest.fn() };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      if (key === 'PAYROLL_MAX_RETRY_ATTEMPTS') return 5;
      return defaultValue;
    }),
  };
  const eventClaim = { claimAndProcess: jest.fn() };
  const heartbeat = { touch: jest.fn() };

  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      name: PAYROLL_EVENT_JOB,
      data: {
        eventId: 'evt-1',
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
        ...overrides,
      },
      attemptsMade: 0,
      opts: { attempts: 5 },
    }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new PayrollEventProcessor(
      prisma as unknown as PrismaService,
      queueService as unknown as PayrollEventQueueService,
      configService as unknown as ConfigService,
      eventClaim as unknown as EventClaim,
      heartbeat as unknown as HeartbeatService,
    );
    // Delegate the transactional lifecycle to EventClaim; default = success.
    eventClaim.claimAndProcess.mockResolvedValue({
      outcome: 'success',
      reference: 'SIM-test-ref',
    });
    heartbeat.touch.mockResolvedValue(undefined);
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollEvent.findFirst.mockResolvedValue(null);
    queueService.enqueue.mockResolvedValue(undefined);
    // Array-form $transaction (onFailed exhaustion): await each op like Prisma.
    prisma.$transaction.mockImplementation(async (ops: unknown[]) => {
      for (const op of ops) {
        await op;
      }
      return ops;
    });
    prisma.eventAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    prisma.eventAttempt.upsert.mockResolvedValue({ id: 'attempt-1' });
  });

  describe('claim → dispatch → success lifecycle (delegated)', () => {
    it('ensures received→queued, touches the heartbeat, and delegates to EventClaim', async () => {
      await processor.process(job());

      // The received → queued ensure stays OUTSIDE the transaction: it is the
      // only updateMany the processor issues itself — and it is tenant-scoped.
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', organizationId: ORG, status: EventStatus.RECEIVED },
        data: { status: EventStatus.QUEUED },
      });

      expect(heartbeat.touch).toHaveBeenCalledTimes(1);

      // The whole claim → dispatch → terminal-write lifecycle went through
      // EventClaim with the identity, the organization, and the 1-based attempt.
      expect(eventClaim.claimAndProcess).toHaveBeenCalledTimes(1);
      expect(eventClaim.claimAndProcess).toHaveBeenCalledWith({
        eventId: 'evt-1',
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
        attempt: 1,
      });
    });

    it('logs the succeeded line with the outcome reference', async () => {
      const logSpy = jest.spyOn(processor['logger'], 'log');
      await processor.process(job());

      const succeeded = logSpy.mock.calls.find((c) =>
        String(c[0]).includes('succeeded'),
      );
      expect(succeeded).toBeDefined();
      expect(String(succeeded![0])).toContain('reference SIM-test-ref');
    });
  });

  // ── Retry / Failure Strategy (R1) ─────────────────────────────────────────

  describe('transient failure — claimAndProcess re-throws (R1, D1, D2)', () => {
    beforeEach(() => {
      eventClaim.claimAndProcess.mockRejectedValue(
        new TransientPayrollFailureError('simulated down'),
      );
    });

    it('re-throws WITHOUT any explicit processing → queued reset write (the tx abort is the reset)', async () => {
      await expect(processor.process(job())).rejects.toBeInstanceOf(
        TransientPayrollFailureError,
      );

      // Only the received → queued ensure ran at the processor layer — no
      // `processing → queued` reset update. The audit row for the attempt is a
      // separate eventAttempt write, not a payroll_events write.
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(1);
      const writtenStatuses = (prisma.payrollEvent.updateMany.mock.calls as Array<
        [{ data: { status: EventStatus } }]
      >).map((c) => c[0].data.status);
      expect(writtenStatuses).not.toContain(EventStatus.PROCESSING);
      expect(writtenStatuses).not.toContain(EventStatus.FAILED);
    });

    it('records the attempt as FAILED(TEMPORARY) at the 1-based attempt number (every-attempt audit)', async () => {
      await expect(processor.process(job())).rejects.toBeInstanceOf(
        TransientPayrollFailureError,
      );

      // Attempt 1 ran and failed transiently → its FAILED(TEMPORARY) row is
      // appended outside the aborted claim, so the UI shows the retry cycle.
      expect(prisma.eventAttempt.create).toHaveBeenCalledWith({
        data: {
          eventId: 'evt-1',
          attemptNumber: 1,
          status: 'FAILED',
          errorType: 'TEMPORARY',
          failedReason: 'simulated down',
        },
      });
    });

    it('never masks the transient error when the audit write itself fails', async () => {
      prisma.eventAttempt.create.mockRejectedValueOnce(
        new Error('connection reset'),
      );

      await expect(processor.process(job())).rejects.toBeInstanceOf(
        TransientPayrollFailureError,
      );
    });

    it('logs a retrying entry at warn level with attempt/max context', async () => {
      const logSpy = jest.spyOn(processor['logger'], 'warn');
      await expect(processor.process(job())).rejects.toThrow();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('retrying'));
      const warnMsg = logSpy.mock.calls[0][0] as string;
      expect(warnMsg).toContain('evt-1');
      expect(warnMsg).toContain('emp-1');
      expect(warnMsg).toContain('1/5');
    });
  });

  describe('permanent failure — terminal verdict from claimAndProcess (R1, D1)', () => {
    beforeEach(() => {
      eventClaim.claimAndProcess.mockResolvedValue({
        outcome: 'permanent-failure',
        reason: 'business rejection',
      });
    });

    it('does NOT re-throw (no further BullMQ attempts)', async () => {
      await expect(processor.process(job())).resolves.toBeUndefined();
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledTimes(1); // ensure only
    });

    it('logs a permanent-failure entry at error level with the reason', async () => {
      const logSpy = jest.spyOn(processor['logger'], 'error');
      await processor.process(job());

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('permanent-failure'),
      );
      expect(String(logSpy.mock.calls[0][0])).toContain('business rejection');
    });
  });

  describe('unknown error from the transaction — treated as infrastructure', () => {
    it('does NOT re-throw the Transient class but re-throws the raw error', async () => {
      eventClaim.claimAndProcess.mockRejectedValue(new Error('db timeout'));

      await expect(processor.process(job())).rejects.toThrow('db timeout');
      const logSpy = jest.spyOn(processor['logger'], 'error');
      await processor.process(job()).catch(() => undefined);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('retrying (infrastructure)'),
      );
    });
  });

  describe('exhausted-retry handler — @OnWorkerEvent("failed") (R1, D4, R5)', () => {
    const transientError = new TransientPayrollFailureError('down');

    const exhaustedJob = {
      name: PAYROLL_EVENT_JOB,
      data: {
        eventId: 'evt-x',
        organizationId: ORG,
        employeeId: 'emp-x',
        eventType: EventType.SALARY_CHANGE,
        sequence: 3,
      },
      attemptsMade: 5,
      opts: { attempts: 5 },
    } as never;

    const midRetryJob = {
      name: PAYROLL_EVENT_JOB,
      data: {
        eventId: 'evt-y',
        organizationId: ORG,
        employeeId: 'emp-y',
        eventType: EventType.ADDRESS_CHANGE,
        sequence: 1,
      },
      attemptsMade: 2,
      opts: { attempts: 5 },
    } as never;

    it('writes failed row + FAILED(TEMPORARY) attempt row in ONE $transaction array when exhausted', async () => {
      // job.attemptsMade >= job.opts.attempts → exhausted (5 attempts ran).
      await processor.onFailed(exhaustedJob, transientError);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(ops).toHaveLength(2);

      // The terminal write is tenant-scoped: a job can only fail a row in its
      // own organization.
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-x', organizationId: ORG, status: EventStatus.QUEUED },
        data: { status: EventStatus.FAILED },
      });
      // The audit row records the FINAL attempt that consumed the retries. It
      // is upserted against the (event_id, attempt_number) key — process()
      // already appended the FAILED(TEMPORARY) row for that attempt outside the
      // aborted claim, so this is idempotent; the create-path stays as the
      // backstop for infrastructure-exhausted events that recorded no rows.
      expect(prisma.eventAttempt.upsert).toHaveBeenCalledWith({
        where: {
          eventId_attemptNumber: { eventId: 'evt-x', attemptNumber: 5 },
        },
        create: {
          eventId: 'evt-x',
          attemptNumber: 5,
          status: 'FAILED',
          errorType: 'TEMPORARY',
          failedReason: 'down',
        },
        update: { failedReason: 'down' },
      });
    });

    it('logs an exhausted entry at error level when all attempts are consumed', async () => {
      const logSpy = jest.spyOn(processor['logger'], 'error');

      await processor.onFailed(exhaustedJob, transientError);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('exhausted'));
    });

    it('is a no-op (no DB write) when there are remaining attempts (mid-retry)', async () => {
      await processor.onFailed(midRetryJob, transientError);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.eventAttempt.create).not.toHaveBeenCalled();
      expect(prisma.eventAttempt.upsert).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
    });

    it('ignores jobs with an unrecognised name', async () => {
      const otherJob = {
        name: 'some-other-job',
        data: {
          eventId: 'evt-z',
          organizationId: ORG,
          employeeId: 'emp-z',
          eventType: EventType.ADDRESS_CHANGE,
          sequence: 1,
        },
        attemptsMade: 5,
        opts: { attempts: 5 },
      } as never;

      await processor.onFailed(otherJob, transientError);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.eventAttempt.create).not.toHaveBeenCalled();
    });
  });

  // ── Pre-existing lifecycle tests (unchanged behaviour) ────────────────────

  describe('stale / duplicate job', () => {
    it('logs skip when claimAndProcess reports the row is no longer queued', async () => {
      eventClaim.claimAndProcess.mockResolvedValue({ outcome: 'skipped' });

      const logSpy = jest.spyOn(processor['logger'], 'warn');
      await processor.process(job());

      expect(claimResolver()).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping stale/duplicate job for event evt-1'),
      );
      // No relay — the completed event drives FIFO continuation, not process().
      expect(queueService.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.findFirst).not.toHaveBeenCalled();
    });

    it('never double-applies: a crash-then-reprocess cannot succeed twice', async () => {
      // Row already SUCCESS → claimAndProcess reports skipped on reprocess.
      eventClaim.claimAndProcess.mockResolvedValue({ outcome: 'skipped' });

      await processor.process(job());

      expect(processor['logger']).toBeTruthy(); // no throw, no terminal write
      const terminal = prisma.payrollEvent.updateMany.mock.calls[1];
      expect(terminal).toBeUndefined();
    });

    function claimResolver(): unknown {
      return eventClaim.claimAndProcess.mock.results[0]?.value;
    }
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
          organizationId: ORG,
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
        organizationId: ORG,
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

    it('does not relay another organization’s pending event for the same employee', async () => {
      // Organization B has a pending event for emp-1, but the completed job
      // belongs to organization A: the lookup is tenant-scoped, so a completion
      // in one tenant can never schedule another tenant's work.
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await processor.onCompleted(job({ organizationId: OTHER_ORG }));

      expect(prisma.payrollEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: OTHER_ORG,
            employeeId: 'emp-1',
          }),
        }),
      );
      expect(queueService.enqueue).not.toHaveBeenCalled();
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
