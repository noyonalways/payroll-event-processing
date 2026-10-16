import { EventClaim } from './event-claim';
import { PrismaService } from '@repo/database';
import { HandlerRegistry } from './handler-registry';
import { EventStatus } from '@prisma/client';
import { EventType, TransientPayrollFailureError, PermanentPayrollFailureError, ProcessingResult } from '@repo/shared';
const ORG = 'org-a';
const OTHER_ORG = 'org-b';

/**
 * Unit coverage for the transactional claim (design D1). `prisma.$transaction`
 * is mocked to run the interactive callback against a mock `tx` client, so each
 * assertion inspects the exact statement ORDER and DATA the transaction would
 * send to Postgres. The "rejected transaction" case proves a DB error aborts
 * (rolls back) instead of partially committing.
 *
 * Every statement is additionally scoped by the job's organization, so the tests
 * also assert that the organization is bound into each WHERE clause rather than
 * being trusted from the event id alone.
 */
describe('EventClaim (transactional claim & process)', () => {
  const tx = {
    $queryRaw: jest.fn(),
    payrollEvent: { updateMany: jest.fn(), findFirst: jest.fn() },
    eventAttempt: { create: jest.fn() },
  };
  const prisma = { $transaction: jest.fn() };
  const registry = { resolve: jest.fn() };

  const successResult: ProcessingResult = {
    reference: 'SIM-test-ref',
    employeeId: 'emp-1',
    effectiveDate: '2026-09-01',
    acknowledged: { iban: 'DE89370400440532013000' },
  };

  const INPUT = {
    eventId: 'evt-1',
    organizationId: ORG,
    eventType: EventType.BANK_ACCOUNT_CHANGE,
    employeeId: 'emp-1',
    sequence: 1,
    attempt: 2,
  };

  const stubStrategy = (behavior: 'success' | 'transient' | 'permanent') => ({
    handle: jest.fn(async () => {
      if (behavior === 'transient') {
        throw new TransientPayrollFailureError('simulated down');
      }
      if (behavior === 'permanent') {
        throw new PermanentPayrollFailureError('business rejection');
      }
      return successResult;
    }),
  });

  let eventClaim: EventClaim;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (
        cb: (t: typeof tx) => Promise<unknown>,
        _opts?: { timeout: number; maxWait: number },
      ) => cb(tx),
    );
    tx.$queryRaw.mockResolvedValue([{ id: 'evt-1' }]);
    tx.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
    tx.payrollEvent.findFirst.mockResolvedValue({
      payload: successResult.acknowledged,
    });
    tx.eventAttempt.create.mockResolvedValue({ id: 'attempt-1' });
    eventClaim = new EventClaim(
      prisma as unknown as PrismaService,
      registry as unknown as HandlerRegistry,
    );
  });

  describe('claim → dispatch → success (atomic commit)', () => {
    beforeEach(() => {
      registry.resolve.mockReturnValue(stubStrategy('success'));
    });

    it('takes the FOR UPDATE row lock before the guarded claim', async () => {
      await eventClaim.claimAndProcess(INPUT);

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const lockOrder = tx.$queryRaw.mock.invocationCallOrder[0];
      const claimOrder = tx.payrollEvent.updateMany.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(claimOrder);
    });

    it('locks and claims by organization as well as event id', async () => {
      await eventClaim.claimAndProcess(INPUT);

      // Raw lock: (strings, eventId, organizationId).
      const [, ...bound] = tx.$queryRaw.mock.calls[0];
      expect(bound).toEqual(['evt-1', ORG]);

      expect(tx.payrollEvent.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'evt-1', organizationId: ORG, status: EventStatus.QUEUED },
        data: { status: EventStatus.PROCESSING },
      });
    });

    it('claims, dispatches via the registry, and commits success + SUCCESS attempt row', async () => {
      const outcome = await eventClaim.claimAndProcess(INPUT);

      expect(outcome).toEqual({ outcome: 'success', reference: 'SIM-test-ref' });

      expect(tx.payrollEvent.findFirst).toHaveBeenCalledWith({
        where: { id: 'evt-1', organizationId: ORG },
        select: { payload: true },
      });

      // Handler dispatch with the identity + payload read in the tx, and the
      // SAME transaction client the claim holds (domain-effects design D2) —
      // a handler's state write travels through the claim's own transaction.
      const strategy = registry.resolve.mock.results[0].value;
      expect(strategy.handle).toHaveBeenCalledWith(
        {
          organizationId: ORG,
          eventId: 'evt-1',
          eventType: EventType.BANK_ACCOUNT_CHANGE,
          employeeId: 'emp-1',
          sequence: 1,
          payload: successResult.acknowledged,
          attempt: 2,
        },
        tx,
      );

      // Terminal write + attempt row, in-process (the tx commits them together).
      expect(tx.payrollEvent.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'evt-1', organizationId: ORG, status: EventStatus.PROCESSING },
        data: {
          status: EventStatus.SUCCESS,
          processedAt: expect.any(Date),
          result: successResult,
        },
      });
      expect(tx.eventAttempt.create).toHaveBeenCalledWith({
        data: {
          eventId: 'evt-1',
          attemptNumber: 2,
          status: 'SUCCESS',
          result: successResult,
        },
      });
    });

    it('opens the transaction with the short-timeout policy', async () => {
      await eventClaim.claimAndProcess(INPUT);
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        { timeout: 10_000, maxWait: 5_000 },
      );
    });

    it('hands the handler the claim’s own transaction client (R5)', async () => {
      // The exact instance identity matters, not just the shape: the handler
      // writes domain state through THIS client, so anything it writes lands
      // inside the claim's transaction and aborts with it on throw.
      await eventClaim.claimAndProcess(INPUT);

      const strategy = registry.resolve.mock.results[0].value;
      expect(strategy.handle).toHaveBeenCalledTimes(1);
      const [, txArg] = strategy.handle.mock.calls[0];
      expect(txArg).toBe(tx);

      // Ordering guarantees the state write happens under the claim: the
      // guarded claim (first updateMany) precedes dispatch, and the terminal
      // write follows it inside the same transaction.
      const claimOrder = tx.payrollEvent.updateMany.mock.invocationCallOrder[0];
      const handleOrder = strategy.handle.mock.invocationCallOrder[0];
      const terminalOrder = (tx.payrollEvent.updateMany.mock.invocationCallOrder as number[])[1];
      expect(claimOrder).toBeLessThan(handleOrder);
      expect(handleOrder).toBeLessThan(terminalOrder);
    });
  });

  describe('stale / duplicate job', () => {
    it('skips with no handler invocation or attempt row when the claim matches 0 rows', async () => {
      tx.payrollEvent.updateMany.mockResolvedValue({ count: 0 });
      registry.resolve.mockReturnValue(stubStrategy('success'));

      const outcome = await eventClaim.claimAndProcess(INPUT);

      expect(outcome).toEqual({ outcome: 'skipped' });
      expect(tx.payrollEvent.updateMany).toHaveBeenCalledTimes(1); // claim only
      expect(tx.payrollEvent.findFirst).not.toHaveBeenCalled();
      expect(tx.eventAttempt.create).not.toHaveBeenCalled();
      const strategy = registry.resolve.mock.results[0].value;
      expect(strategy.handle).not.toHaveBeenCalled();
    });

    it('applies nothing when the job names another organization’s event', async () => {
      // The event id is real, but it belongs to a different organization, so the
      // tenant-scoped claim matches no row — exactly like a stale job.
      tx.payrollEvent.updateMany.mockResolvedValue({ count: 0 });
      registry.resolve.mockReturnValue(stubStrategy('success'));

      const outcome = await eventClaim.claimAndProcess({
        ...INPUT,
        organizationId: OTHER_ORG,
      });

      expect(outcome).toEqual({ outcome: 'skipped' });
      // The organization travels into the filter — the id alone is not authority.
      expect(tx.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', organizationId: OTHER_ORG, status: EventStatus.QUEUED },
        data: { status: EventStatus.PROCESSING },
      });
      expect(tx.eventAttempt.create).not.toHaveBeenCalled();
      const strategy = registry.resolve.mock.results[0].value;
      expect(strategy.handle).not.toHaveBeenCalled();
    });
  });

  describe('transient failure — abort & rollback (no explicit reset)', () => {
    beforeEach(() => {
      registry.resolve.mockReturnValue(stubStrategy('transient'));
    });

    it('re-throws so BullMQ schedules the next attempt', async () => {
      await expect(eventClaim.claimAndProcess(INPUT)).rejects.toBeInstanceOf(
        TransientPayrollFailureError,
      );
    });

    it('applies NO reset update and NO attempt row (the tx rollback is the reset)', async () => {
      await expect(eventClaim.claimAndProcess(INPUT)).rejects.toThrow();

      // Only the claim update ran — the transient throw aborted before any
      // `processing → queued` reset statement (which would be a second write).
      expect(tx.payrollEvent.updateMany).toHaveBeenCalledTimes(1);
      const writtenStatuses = (tx.payrollEvent.updateMany.mock.calls as Array<
        [{ data: { status: EventStatus } }]
      >).map((c) => c[0].data.status);
      expect(writtenStatuses).not.toContain(EventStatus.QUEUED);
      expect(tx.eventAttempt.create).not.toHaveBeenCalled();
    });
  });

  describe('permanent failure — atomic failed + attempt row', () => {
    it('commits processing → failed and a FAILED(PERMANENT) attempt row', async () => {
      registry.resolve.mockReturnValue(stubStrategy('permanent'));

      const outcome = await eventClaim.claimAndProcess(INPUT);

      expect(outcome).toEqual({
        outcome: 'permanent-failure',
        reason: 'business rejection',
      });
      expect(tx.payrollEvent.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'evt-1', organizationId: ORG, status: EventStatus.PROCESSING },
        data: { status: EventStatus.FAILED },
      });
      expect(tx.eventAttempt.create).toHaveBeenCalledWith({
        data: {
          eventId: 'evt-1',
          attemptNumber: 2,
          status: 'FAILED',
          errorType: 'PERMANENT',
          failedReason: 'business rejection',
        },
      });
    });

    it('treats an unknown handler error as permanent with its message as reason', async () => {
      const unknownStrategy = {
        handle: jest.fn(async () => {
          throw new Error('unexpected error');
        }),
      };
      registry.resolve.mockReturnValue(unknownStrategy as never);

      const outcome = await eventClaim.claimAndProcess(INPUT);

      expect(outcome.outcome).toBe('permanent-failure');
      if (outcome.outcome === 'permanent-failure') {
        expect(outcome.reason).toBe('unexpected error');
      }
      expect(tx.eventAttempt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            errorType: 'PERMANENT',
            failedReason: 'unexpected error',
          }),
        }),
      );
    });
  });

  describe('aborted / rejected transaction', () => {
    it('propagates the DB/connection error so the caller sees a rollback, not a partial commit', async () => {
      registry.resolve.mockReturnValue(stubStrategy('success'));
      prisma.$transaction.mockRejectedValue(new Error('connection lost'));

      await expect(eventClaim.claimAndProcess(INPUT)).rejects.toThrow(
        'connection lost',
      );
      // No terminal attempt write "committed" — nothing below the tx boundary.
      expect(tx.eventAttempt.create).not.toHaveBeenCalled();
    });
  });
});
