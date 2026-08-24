import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { EventsService, CreateEventInput } from './events.service';
import { PayloadValidator } from './payload.validator';
import { PrismaService } from '../prisma/prisma.service';
import { EventType } from './event-type';

describe('EventsService', () => {
  let service: EventsService;

  const tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    payrollEvent: { create: jest.fn() },
  };
  const prisma = {
    payrollEvent: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (callback: (t: typeof tx) => Promise<unknown>) => callback(tx)),
  };

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
      ],
    }).compile();

    service = moduleRef.get<EventsService>(EventsService);
    tx.$queryRaw.mockReset();
    tx.$executeRaw.mockReset();
    tx.payrollEvent.create.mockReset();
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
});