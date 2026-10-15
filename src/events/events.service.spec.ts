import { HttpStatus, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsService, CreateEventInput } from './events.service';
import { PayloadValidator } from './payload.validator';
import { PrismaService } from '@repo/database';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION } from '../common/idempotency/idempotency.constants';
import { EventType } from './event-type';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

describe('EventsService', () => {
  let service: EventsService;

  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    payrollEvent: { create: jest.fn() },
  };
  const prisma = {
    payrollEvent: { updateMany: jest.fn(), findFirst: jest.fn() },
    eventAttempt: { findMany: jest.fn() },
  };
  const eventQueue = { enqueue: jest.fn() };
  const idempotency = { execute: jest.fn() };

  const input = (overrides: Partial<CreateEventInput> = {}): CreateEventInput => ({
    eventType: EventType.BANK_ACCOUNT_CHANGE,
    payload: {
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
    idempotencyKey: 'k-1',
    ...overrides,
  });

  // Faithful fresh-submission path: the layer runs the op against the tx with
  // the organization it was handed.
  const freshPath = () => {
    idempotency.execute.mockImplementation(
      async (
        _organizationId: string,
        _scope: string,
        _key: string,
        op: (t: typeof tx) => unknown,
      ) => op(tx),
    );
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayloadValidator, useValue: { validate: jest.fn().mockResolvedValue(undefined) } },
        { provide: PayrollEventQueueService, useValue: eventQueue },
        { provide: IdempotencyService, useValue: idempotency },
      ],
    }).compile();

    service = moduleRef.get<EventsService>(EventsService);
    tx.$queryRaw.mockReset();
    tx.$executeRaw.mockReset();
    tx.payrollEvent.create.mockReset();
    prisma.payrollEvent.updateMany.mockReset();
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollEvent.findFirst.mockReset();
    prisma.eventAttempt.findMany.mockReset();
    eventQueue.enqueue.mockReset();
    eventQueue.enqueue.mockResolvedValue(undefined);
  });

  describe('new event submission', () => {
    it('puts the insert op under the event-submission scope for the caller’s organization and returns 201', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1); // advisory lock
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-new' });

      const result = await service.createEvent(ORG, input());

      expect(result).toEqual({ httpStatus: 201, body: { id: expect.any(String), status: 'received' } });
      expect(idempotency.execute).toHaveBeenCalledWith(
        ORG,
        IDEMPOTENCY_SCOPE_EVENT_SUBMISSION,
        'k-1',
        expect.any(Function),
      );
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1);
    });

    it('inserts the event row with its organization and without response columns', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);

      await service.createEvent(ORG, input());

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(1n);
      expect(data.idempotencyKey).toBe('k-1');
      expect(data.status).toBe('RECEIVED');
      expect(data.organizationId).toBe(ORG);
      expect(data).not.toHaveProperty('responseStatus');
      expect(data).not.toHaveProperty('responseBody');
    });
  });

  describe('replay / race (handled by the idempotency layer)', () => {
    it('returns the stored response for a known key without running the op', async () => {
      // A stored replay carries only { status, body } — no eventId.
      idempotency.execute.mockResolvedValue({
        status: HttpStatus.CREATED,
        body: { id: 'evt-1', status: 'received' },
      });

      const result = await service.createEvent(ORG, input());

      expect(result).toEqual({ httpStatus: 201, body: { id: 'evt-1', status: 'received' } });
      expect(tx.payrollEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('per-employee sequence', () => {
    it('computes MAX(sequence)+1 inside the insert transaction', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 4n }]);

      await service.createEvent(ORG, input());

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(5n);
    });

    it('serializes on a tenant-qualified advisory lock key', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);

      await service.createEvent(ORG, input());

      // The lock key carries the organization: two organizations using the same
      // employee number must not serialize against each other.
      expect(tx.$executeRaw.mock.calls[0][1]).toBe(`${ORG}:emp-1`);
    });

    it('scopes the MAX(sequence) probe to the organization', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);

      await service.createEvent(ORG, input());

      // Raw query: (strings, organizationId, employeeId) — both bound parameters
      // must be present so one organization's sequence space stays its own.
      const [, ...bound] = tx.$queryRaw.mock.calls[0];
      expect(bound).toEqual([ORG, 'emp-1']);
    });
  });

  describe('enqueue on submit (reliability-critical)', () => {
    const persistedNewEvent = () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1); // advisory lock
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-q' });
    };

    it('marks the row queued then enqueues after a successful insert', async () => {
      persistedNewEvent();

      const result = await service.createEvent(ORG, input());

      expect(result).toEqual({ httpStatus: 201, body: { id: expect.any(String), status: 'received' } });
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: result.body.id, organizationId: ORG, status: 'RECEIVED' },
        data: { status: 'QUEUED' },
      });
      expect(eventQueue.enqueue).toHaveBeenCalledWith({
        eventId: result.body.id,
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1, // JSON-safe Number(bigint)
      });
    });

    it('still returns 201 and persists when the queue is unreachable (enqueue rejects)', async () => {
      persistedNewEvent();
      eventQueue.enqueue.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

      const result = await service.createEvent(ORG, input());

      expect(result.httpStatus).toBe(201);
      expect(result.body).toEqual({ id: expect.any(String), status: 'received' });
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1); // row persisted
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: result.body.id, organizationId: ORG, status: 'RECEIVED' },
        data: { status: 'QUEUED' },
      });
    });

    it('does not enqueue (and does not mark queued) for a duplicate Idempotency-Key', async () => {
      idempotency.execute.mockResolvedValue({
        status: HttpStatus.CREATED,
        body: { id: 'evt-1', status: 'received' },
      });

      await service.createEvent(ORG, input());

      expect(eventQueue.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(tx.payrollEvent.create).not.toHaveBeenCalled();
    });

    it('does not enqueue when the layer resolves a race as the winner stored response', async () => {
      // P2002 race → the layer reads the winner and returns its stored response.
      idempotency.execute.mockResolvedValue({
        status: HttpStatus.CREATED,
        body: { id: 'evt-2', status: 'received' },
      });

      const result = await service.createEvent(ORG, input());

      expect(result.body).toEqual({ id: 'evt-2', status: 'received' });
      expect(eventQueue.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getEventStatus (read-only, tenant-scoped)', () => {
    // Faithful committed SUCCESS row as Prisma would return it.
    const row = {
      id: 'evt-1',
      organizationId: ORG,
      eventType: 'BANK_ACCOUNT_CHANGE',
      employeeId: 'emp-1',
      payload: { employeeId: 'emp-1', effectiveDate: '2026-09-01', iban: 'DE89370400440532013000' },
      sequence: 3n,
      idempotencyKey: 'k-1',
      status: 'SUCCESS',
      createdAt: new Date('2026-08-26T00:40:12.000Z'),
      updatedAt: new Date('2026-08-26T00:40:13.000Z'),
      processedAt: new Date('2026-08-26T00:40:13.000Z'),
      result: { reference: 'SIM-1' },
    };

    it('throws NotFoundException for an unknown id and does not query attempts', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await expect(service.getEventStatus(ORG, 'missing')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.payrollEvent.findFirst).toHaveBeenCalledWith({
        where: { id: 'missing', organizationId: ORG },
      });
      expect(prisma.eventAttempt.findMany).not.toHaveBeenCalled();
    });

    it('reports another organization’s event as not found and reads no attempts', async () => {
      // The event exists — just not for this organization. The tenant-filtered
      // lookup returns nothing, so the caller learns only that it is absent.
      prisma.payrollEvent.findFirst.mockResolvedValue(null);

      await expect(service.getEventStatus(OTHER_ORG, 'evt-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.payrollEvent.findFirst).toHaveBeenCalledWith({
        where: { id: 'evt-1', organizationId: OTHER_ORG },
      });
      expect(prisma.eventAttempt.findMany).not.toHaveBeenCalled();
    });

    it('maps the row (BigInt→number, dates→ISO, null passthrough) and orders attempts ascending', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue({
        ...row,
        processedAt: null,
        result: null,
        status: 'QUEUED',
      });
      prisma.eventAttempt.findMany.mockResolvedValue([
        {
          id: 'a2',
          eventId: 'evt-1',
          attemptNumber: 2,
          status: 'FAILED',
          errorType: 'TEMPORARY',
          failedReason: 'flaky provider',
          result: null,
          createdAt: new Date('2026-08-26T00:40:14.000Z'),
        },
        {
          id: 'a1',
          eventId: 'evt-1',
          attemptNumber: 1,
          status: 'SUCCESS',
          errorType: null,
          failedReason: null,
          result: { reference: 'SIM-1' },
          createdAt: new Date('2026-08-26T00:40:13.000Z'),
        },
      ]);

      const result = await service.getEventStatus(ORG, 'evt-1');

      expect(prisma.eventAttempt.findMany).toHaveBeenCalledWith({
        where: { eventId: 'evt-1' },
        orderBy: { attemptNumber: 'asc' },
      });
      // The mock returns the trail out of order; the service must re-sort so the
      // DTO contract (ascending attemptNumber) holds regardless of store order.
      expect(result).toEqual({
        id: 'evt-1',
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: 'emp-1',
        sequence: 3, // BigInt coerced to Number — never leaks raw BigInt
        status: 'queued', // enum lowercased to the documented wire format
        payload: { employeeId: 'emp-1', effectiveDate: '2026-09-01', iban: 'DE89370400440532013000' },
        createdAt: '2026-08-26T00:40:12.000Z',
        updatedAt: '2026-08-26T00:40:13.000Z',
        processedAt: null,
        result: null,
        attempts: [
          {
            attemptNumber: 1,
            status: 'SUCCESS',
            errorType: null,
            failedReason: null,
            result: { reference: 'SIM-1' },
            createdAt: '2026-08-26T00:40:13.000Z',
          },
          {
            attemptNumber: 2,
            status: 'FAILED',
            errorType: 'TEMPORARY',
            failedReason: 'flaky provider',
            result: null,
            createdAt: '2026-08-26T00:40:14.000Z',
          },
        ],
      });
    });

    it('produces a strictly JSON-serializable object (no BigInt, no raw Date)', async () => {
      prisma.payrollEvent.findFirst.mockResolvedValue(row);
      prisma.eventAttempt.findMany.mockResolvedValue([]);

      const result = await service.getEventStatus(ORG, 'evt-1');
      const roundTripped = JSON.parse(JSON.stringify(result));

      expect(roundTripped).toEqual({
        ...result,
        sequence: 3,
        createdAt: '2026-08-26T00:40:12.000Z',
        updatedAt: '2026-08-26T00:40:13.000Z',
        processedAt: '2026-08-26T00:40:13.000Z',
      });
      expect(roundTripped.attempts).toEqual([]);
    });
  });
});
