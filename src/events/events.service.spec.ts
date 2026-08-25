import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventsService, CreateEventInput } from './events.service';
import { PayloadValidator } from './payload.validator';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { IdempotencyService } from '../common/idempotency/idempotency.service';
import { IDEMPOTENCY_SCOPE_EVENT_SUBMISSION } from '../common/idempotency/idempotency.constants';
import { EventType } from './event-type';

describe('EventsService', () => {
  let service: EventsService;

  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    payrollEvent: { create: jest.fn() },
  };
  const prisma = {
    payrollEvent: { updateMany: jest.fn() },
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

  // Faithful fresh-submission path: the layer runs the op against the tx.
  const freshPath = () => {
    idempotency.execute.mockImplementation(async (_scope: string, _key: string, op: (t: typeof tx) => unknown) =>
      op(tx),
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
    eventQueue.enqueue.mockReset();
    eventQueue.enqueue.mockResolvedValue(undefined);
  });

  describe('new event submission', () => {
    it('puts the insert op under the event-submission scope and returns 201', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1); // advisory lock
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-new' });

      const result = await service.createEvent(input());

      expect(result).toEqual({ httpStatus: 201, body: { id: expect.any(String), status: 'received' } });
      expect(idempotency.execute).toHaveBeenCalledWith(
        IDEMPOTENCY_SCOPE_EVENT_SUBMISSION,
        'k-1',
        expect.any(Function),
      );
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1);
    });

    it('inserts the event row without response columns (persistence moved to the idempotency record)', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);

      await service.createEvent(input());

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(1n);
      expect(data.idempotencyKey).toBe('k-1');
      expect(data.status).toBe('RECEIVED');
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

      const result = await service.createEvent(input());

      expect(result).toEqual({ httpStatus: 201, body: { id: 'evt-1', status: 'received' } });
      expect(tx.payrollEvent.create).not.toHaveBeenCalled();
    });
  });

  describe('per-employee sequence', () => {
    it('computes MAX(sequence)+1 inside the insert transaction', async () => {
      freshPath();
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 4n }]);

      await service.createEvent(input());

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(5n);
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

      const result = await service.createEvent(input());

      expect(result).toEqual({ httpStatus: 201, body: { id: expect.any(String), status: 'received' } });
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: result.body.id, status: 'RECEIVED' },
        data: { status: 'QUEUED' },
      });
      expect(eventQueue.enqueue).toHaveBeenCalledWith({
        eventId: result.body.id,
        eventType: EventType.BANK_ACCOUNT_CHANGE,
        employeeId: 'emp-1',
        sequence: 1, // JSON-safe Number(bigint)
      });
    });

    it('still returns 201 and persists when the queue is unreachable (enqueue rejects)', async () => {
      persistedNewEvent();
      eventQueue.enqueue.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:6379'));

      const result = await service.createEvent(input());

      expect(result.httpStatus).toBe(201);
      expect(result.body).toEqual({ id: expect.any(String), status: 'received' });
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1); // row persisted
      expect(prisma.payrollEvent.updateMany).toHaveBeenCalledWith({
        where: { id: result.body.id, status: 'RECEIVED' },
        data: { status: 'QUEUED' },
      });
    });

    it('does not enqueue (and does not mark queued) for a duplicate Idempotency-Key', async () => {
      idempotency.execute.mockResolvedValue({
        status: HttpStatus.CREATED,
        body: { id: 'evt-1', status: 'received' },
      });

      await service.createEvent(input());

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

      const result = await service.createEvent(input());

      expect(result.body).toEqual({ id: 'evt-2', status: 'received' });
      expect(eventQueue.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
    });
  });
});