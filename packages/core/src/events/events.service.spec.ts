import { HttpStatus, NotFoundException, BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsService, CreateEventInput, encodeEventListCursor } from './events.service';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './dto/events-list.dto';
import { PayloadValidator } from './payload.validator';
import { PrismaService } from '@repo/database';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { EventStatusPublisher } from './event-status.publisher';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION, EventType } from '@repo/shared';
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
    payrollEvent: { updateMany: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    eventAttempt: { findMany: jest.fn() },
    employee: { findUnique: jest.fn() },
  };
  const eventQueue = { enqueueBestEffort: jest.fn() };
  const idempotency = { execute: jest.fn() };
  const streamPublisher = { publish: jest.fn() };

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
        { provide: EventStatusPublisher, useValue: streamPublisher },
      ],
    }).compile();

    service = moduleRef.get<EventsService>(EventsService);
    tx.$queryRaw.mockReset();
    tx.$executeRaw.mockReset();
    tx.payrollEvent.create.mockReset();
    prisma.payrollEvent.updateMany.mockReset();
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.payrollEvent.findFirst.mockReset();
    prisma.payrollEvent.findMany.mockReset();
    prisma.eventAttempt.findMany.mockReset();
    // Default: the directory knows `emp-1` as an ACTIVE employee. Gate tests
    // override this; everything else expects the pass-through path.
    prisma.employee.findUnique.mockReset();
    prisma.employee.findUnique.mockResolvedValue({
      id: 'emp-row-1',
      employeeNumber: 'emp-1',
      active: true,
    });
    eventQueue.enqueueBestEffort.mockReset();
    eventQueue.enqueueBestEffort.mockResolvedValue(undefined);
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

  describe('employee directory gate (employee-directory, R1/R2)', () => {
    it('looks the employeeId up on the tenant-qualified unique key and proceeds on an active employee', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-gate-ok' });

      const result = await service.createEvent(ORG, input());

      expect(prisma.employee.findUnique).toHaveBeenCalledWith({
        where: {
          organizationId_employeeNumber: { organizationId: ORG, employeeNumber: 'emp-1' },
        },
        select: { active: true },
      });
      expect(result.httpStatus).toBe(201);
      expect(idempotency.execute).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown employee with 422 before the idempotency layer is consulted', async () => {
      prisma.employee.findUnique.mockResolvedValue(null);
      // Log-line parity: the rejection log carries the context fields the
      // events module convention requires (employeeId, eventType, organization,
      // key) plus the validation stage — no eventId exists yet.
      const warnSpy = jest.spyOn(
        (service as unknown as { logger: { warn: (message: string) => void } }).logger,
        'warn',
      );

      await expect(service.createEvent(ORG, input())).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('employeeId "emp-1" is unknown'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('validation stage=directory-gate'),
      );

      // A 422 is reported before the layer: the key was never handed to it.
      expect(idempotency.execute).not.toHaveBeenCalled();
      expect(tx.payrollEvent.create).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
    });

    it('rejects an archived employee with the same 422', async () => {
      prisma.employee.findUnique.mockResolvedValue({ id: 'emp-row-1', active: false });

      await expect(
        service.createEvent(OTHER_ORG, input()),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(idempotency.execute).not.toHaveBeenCalled();
    });

    it('does not consume the Idempotency-Key: the same key creates a fresh event once the employee exists', async () => {
      // Attempt 1 — the directory does not know the employee yet.
      prisma.employee.findUnique.mockResolvedValueOnce(null);
      await expect(service.createEvent(ORG, input())).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(idempotency.execute).not.toHaveBeenCalled();

      // The organization registers the employee; the SAME key resubmits.
      prisma.employee.findUnique.mockResolvedValue({ id: 'e1', active: true });
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-after-register' });

      const result = await service.createEvent(ORG, input());

      expect(result).toEqual({
        httpStatus: HttpStatus.CREATED,
        body: { id: expect.any(String), status: 'received' },
      });
      // The layer ran exactly once for the one submission that got through —
      // the rejected attempt stored no 422 response to replay.
      expect(idempotency.execute).toHaveBeenCalledTimes(1);
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1);
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
      expect(eventQueue.enqueueBestEffort).toHaveBeenCalledWith({
        eventId: result.body.id,
        organizationId: ORG,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1, // JSON-safe Number(bigint)
      });
    });

    it('still returns 201 and persists when the queue is unreachable (enqueue rejects)', async () => {
      persistedNewEvent();
      eventQueue.enqueueBestEffort.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

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

      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
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
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('stream announcements (realtime-status, post-commit best-effort)', () => {
    const persistedNewEvent = () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-stream' });
    };

    it('announces `queued` on the stream when the guarded mark-queued applied', async () => {
      persistedNewEvent();

      const result = await service.createEvent(ORG, input());

      expect(streamPublisher.publish).toHaveBeenCalledWith({
        organizationId: ORG,
        eventId: result.body.id,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1,
        status: 'queued',
        occurredAt: expect.any(String),
      });
    });

    it('publishes nothing when the caller replays a stored response (no fresh transition)', async () => {
      idempotency.execute.mockResolvedValue({
        status: HttpStatus.CREATED,
        body: { id: 'evt-1', status: 'received' },
      });

      await service.createEvent(ORG, input());

      expect(streamPublisher.publish).not.toHaveBeenCalled();
    });

    it('still returns 201 and publishes nothing when the mark-queued transition fails', async () => {
      persistedNewEvent();
      // The guarded write itself fails (Postgres hiccup): the row stays
      // `received`, so there is no committed `queued` transition to announce —
      // and the 201 must be untouched by the stream path (R2).
      prisma.payrollEvent.updateMany.mockRejectedValue(new Error('connection reset'));

      const result = await service.createEvent(ORG, input());

      expect(result.httpStatus).toBe(201);
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1);
      expect(streamPublisher.publish).not.toHaveBeenCalled();
    });

    it('publishes nothing when another path already queued the row (count 0)', async () => {
      persistedNewEvent();
      prisma.payrollEvent.updateMany.mockResolvedValue({ count: 0 });

      await service.createEvent(ORG, input());

      expect(streamPublisher.publish).not.toHaveBeenCalled();
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

  describe('listEvents (read-only, tenant-scoped, events-query-api)', () => {
    // Rows exactly as Prisma's findMany with the narrow select returns them.
    const historyRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'evt-1',
      eventType: 'BANK_ACCOUNT_CHANGE',
      employeeId: 'emp-1',
      sequence: 3n,
      status: 'SUCCESS',
      createdAt: new Date('2026-08-26T00:40:12.000Z'),
      updatedAt: new Date('2026-08-26T00:40:13.000Z'),
      processedAt: new Date('2026-08-26T00:40:13.000Z'),
      ...overrides,
    });

    const fullPayloadRow = () => ({
      ...historyRow(),
      // Fields the projection must never carry — a faithful Prisma row has them
      // without `select`, so their absence proves the projection is narrow.
      payload: { employeeId: 'emp-1', iban: 'DE89370400440532013000' },
      result: { reference: 'SIM-1' },
      idempotencyKey: 'k-1',
    });

    it('scopes the page to the caller’s organization, even with an employeeId filter', async () => {
      // Two organizations use the SAME employee number; org-b's rows must be
      // unreachable no matter what filters the caller sends.
      prisma.payrollEvent.findMany.mockResolvedValue([]);

      await service.listEvents(OTHER_ORG, { employeeId: 'emp-1' });

      expect(prisma.payrollEvent.findMany).toHaveBeenCalledTimes(1);
      const args = prisma.payrollEvent.findMany.mock.calls[0][0];
      expect(args.where.organizationId).toBe(OTHER_ORG);
      expect(args.where.employeeId).toBe('emp-1');
    });

    it('orders newest first with (created_at DESC, id DESC) and takes limit+1', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue([]);

      await service.listEvents(ORG, { limit: 5 });

      const args = prisma.payrollEvent.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([
        { createdAt: 'desc' },
        { id: 'desc' },
      ]);
      // One extra row answers "is there a next page?" without a count query.
      expect(args.take).toBe(6);
    });

    it('defaults the page size to 20 when the caller omits limit', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue([]);

      const result = await service.listEvents(ORG);

      const args = prisma.payrollEvent.findMany.mock.calls[0][0];
      expect(args.take).toBe(DEFAULT_PAGE_LIMIT + 1);
      expect(result.limit).toBe(DEFAULT_PAGE_LIMIT);
    });

    it('composes every filter AND-ed into ONE where (status uppercased, dates bounded)', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue([]);

      await service.listEvents(ORG, {
        status: 'failed',
        eventType: EventType.SALARY_CHANGE,
        employeeId: 'emp-7',
        createdAfter: '2026-08-01T00:00:00.000Z',
        createdBefore: '2026-08-31T23:59:59.999Z',
      });

      const args = prisma.payrollEvent.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        organizationId: ORG,
        status: 'FAILED', // wire 'failed' → stored enum
        eventType: 'SALARY_CHANGE',
        employeeId: 'emp-7',
        createdAt: {
          gte: new Date('2026-08-01T00:00:00.000Z'), // inclusive
          lte: new Date('2026-08-31T23:59:59.999Z'), // inclusive
        },
      });
    });

    it('decodes the cursor into a seek position strictly after the last served row', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue([]);
      const cursor = encodeEventListCursor({
        createdAt: new Date('2026-08-26T00:40:12.000Z'),
        id: 'evt-last',
      });

      await service.listEvents(ORG, { cursor });

      const args = prisma.payrollEvent.findMany.mock.calls[0][0];
      expect(args.where.OR).toEqual([
        { createdAt: { lt: new Date('2026-08-26T00:40:12.000Z') } },
        {
          createdAt: new Date('2026-08-26T00:40:12.000Z'),
          id: { lt: 'evt-last' },
        },
      ]);
    });

    it('rejects an undecodable cursor as a structured 400', async () => {
      await expect(service.listEvents(ORG, { cursor: '@@not-a-cursor@@' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.listEvents(ORG, { cursor: Buffer.from('{"v":2}').toString('base64url') })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.payrollEvent.findMany).not.toHaveBeenCalled();
    });

    it('moves the cursor to the last row of the page only when a further row exists', async () => {
      const rows = [1, 2, 3].map((n) => historyRow({ id: `evt-${n}` }));
      prisma.payrollEvent.findMany.mockResolvedValue(rows);

      const full = await service.listEvents(ORG, { limit: 2 });

      expect(full.data).toHaveLength(2);
      expect(full.limit).toBe(2);
      // The third row exists but is not served; the cursor points at the last
      // row OF the page, so the next page continues exactly after it.
      expect(JSON.parse(Buffer.from(full.nextCursor!, 'base64url').toString('utf8'))).toEqual({
        v: 1,
        t: '2026-08-26T00:40:12.000Z',
        i: 'evt-2',
      });

      // Last page: every row served, no cursor — the walk terminates.
      prisma.payrollEvent.findMany.mockResolvedValue([rows[2]]);
      const last = await service.listEvents(ORG, { limit: 2 });
      expect(last.data).toHaveLength(1);
      expect(last.nextCursor).toBeNull();
    });

    it('projects a narrow row: no payload, result, idempotency key, or attempts', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue([fullPayloadRow()]);

      const result = await service.listEvents(ORG, { limit: 1 });

      const item = result.data[0];
      expect(item).toEqual({
        id: 'evt-1',
        eventType: 'BANK_ACCOUNT_CHANGE',
        employeeId: 'emp-1',
        sequence: 3, // BigInt coerced to Number — never leaks raw BigInt
        status: 'success', // enum lowercased to the documented wire format
        createdAt: '2026-08-26T00:40:12.000Z',
        updatedAt: '2026-08-26T00:40:13.000Z',
        processedAt: '2026-08-26T00:40:13.000Z',
      });
      expect(JSON.parse(JSON.stringify(item))).not.toHaveProperty('payload');
      expect(JSON.parse(JSON.stringify(item))).not.toHaveProperty('result');
      // The service never drafted the heavy columns it does not serve.
      const select = prisma.payrollEvent.findMany.mock.calls[0][0].select;
      expect(select.payload).toBeUndefined();
      expect(select.result).toBeUndefined();
    });

    it('issues no writes: only the one findMany happens', async () => {
      prisma.payrollEvent.findMany.mockResolvedValue(
        Array.from({ length: MAX_PAGE_LIMIT }, (_, i) => historyRow({ id: `evt-${i}` })),
      );

      await service.listEvents(ORG, { limit: 10, status: 'queued' });

      // Read path signature: exactly one findMany — no create/update/upsert on
      // events or attempts, and no queue work. Listing history can never touch
      // lifecycle state (design D6).
      expect(prisma.payrollEvent.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.findFirst).not.toHaveBeenCalled();
      expect(prisma.eventAttempt.findMany).not.toHaveBeenCalled();
      expect(eventQueue.enqueueBestEffort).not.toHaveBeenCalled();
      expect(idempotency.execute).not.toHaveBeenCalled();
    });
  });
});
