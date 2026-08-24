import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EventsService, CreateEventInput } from './events.service';
import { PayloadValidator } from './payload.validator';
import { PrismaService } from '../prisma/prisma.service';
import { PayrollEventQueueService } from '../queue/payroll-event-queue.service';
import { EventType } from './event-type';

describe('EventsService', () => {
  let service: EventsService;

  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    payrollEvent: { create: jest.fn() },
  };
  const prisma = {
    payrollEvent: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const eventQueue = { enqueue: jest.fn() };

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

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PayloadValidator, useValue: { validate: jest.fn().mockResolvedValue(undefined) } },
        { provide: PayrollEventQueueService, useValue: eventQueue },
      ],
    }).compile();

    service = moduleRef.get<EventsService>(EventsService);
    tx.$queryRaw.mockReset();
    tx.$executeRaw.mockReset();
    tx.payrollEvent.create.mockReset();
    prisma.payrollEvent.updateMany.mockReset();
    eventQueue.enqueue.mockReset();
    eventQueue.enqueue.mockResolvedValue(undefined);
    prisma.payrollEvent.updateMany.mockResolvedValue({ count: 1 });
  });

  describe('new event submission', () => {
    it('inserts once and returns 201 { id, status: "received" }', async () => {
      prisma.payrollEvent.findUnique.mockResolvedValue(null);
      tx.$executeRaw.mockResolvedValue(1); // advisory lock
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockResolvedValue({ id: 'evt-new' });

      const result = await service.createEvent(input());

      expect(result).toEqual({ httpStatus: 201, body: { id: expect.any(String), status: 'received' } });
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.payrollEvent.create).not.toHaveBeenCalled();

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(1n);
      expect(data.idempotencyKey).toBe('k-1');
      expect(data.status).toBe('RECEIVED');
      expect(data.responseStatus).toBe(HttpStatus.CREATED);
      expect(data.responseBody).toEqual({ id: data.id, status: 'received' });
    });
  });

  describe('idempotency (dedupe by idempotency_key)', () => {
    it('returns the stored response for a known key without inserting', async () => {
      prisma.payrollEvent.findUnique.mockResolvedValue({
        responseStatus: 201,
        responseBody: { id: 'evt-1', status: 'received' },
      });

      const result = await service.createEvent(input());

      expect(result).toEqual({ httpStatus: 201, body: { id: 'evt-1', status: 'received' } });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns the stored response when the insert hits a unique violation (P2002 race)', async () => {
      prisma.payrollEvent.findUnique
        .mockResolvedValueOnce(null) // pre-check misses
        .mockResolvedValueOnce({
          responseStatus: 201,
          responseBody: { id: 'evt-2', status: 'received' },
        }); // re-read after the race
      // Faithful simulation: the transaction runs normally, but the create
      // violates UNIQUE(idempotency_key) and the whole transaction aborts.
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      const result = await service.createEvent(input());

      expect(result.body).toEqual({ id: 'evt-2', status: 'received' });
      expect(prisma.payrollEvent.findUnique).toHaveBeenCalledTimes(2);
      expect(tx.payrollEvent.create).toHaveBeenCalledTimes(1); // only the failed attempt
    });
  });

  describe('per-employee sequence', () => {
    it('computes MAX(sequence)+1 inside the insert transaction', async () => {
      prisma.payrollEvent.findUnique.mockResolvedValue(null);
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 4n }]);

      await service.createEvent(input());

      const data = tx.payrollEvent.create.mock.calls[0][0].data;
      expect(data.sequence).toBe(5n);
    });
  });

  describe('enqueue on submit (reliability-critical)', () => {
    const persistedNewEvent = () => {
      prisma.payrollEvent.findUnique.mockResolvedValue(null);
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

    it("still returns 201 and persists when the queue is unreachable (enqueue rejects)", async () => {
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
      prisma.payrollEvent.findUnique.mockResolvedValue({
        responseStatus: 201,
        responseBody: { id: 'evt-1', status: 'received' },
      });

      await service.createEvent(input());

      expect(eventQueue.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('does not enqueue when the insert hits the unique-violation race', async () => {
      prisma.payrollEvent.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          responseStatus: 201,
          responseBody: { id: 'evt-2', status: 'received' },
        });
      tx.$executeRaw.mockResolvedValue(1);
      tx.$queryRaw.mockResolvedValueOnce([{ max: 0n }]);
      tx.payrollEvent.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      const result = await service.createEvent(input());

      expect(result.body).toEqual({ id: 'evt-2', status: 'received' });
      expect(eventQueue.enqueue).not.toHaveBeenCalled();
      expect(prisma.payrollEvent.updateMany).not.toHaveBeenCalled();
    });
  });
});