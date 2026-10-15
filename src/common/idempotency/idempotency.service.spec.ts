import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyService } from './idempotency.service';

type MockTx = {
  idempotencyRecord: { create: jest.Mock; deleteMany: jest.Mock };
};

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

describe('IdempotencyService', () => {
  let service: IdempotencyService;
  const tx: MockTx = {
    idempotencyRecord: {
      create: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    idempotencyRecord: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(
      async (callback: (t: MockTx) => Promise<unknown>) => callback(tx),
    ),
  };
  const config = { get: jest.fn() };

  const op = jest.fn(async () => ({
    status: 201,
    body: { id: 'evt-1', status: 'received' },
  }));

  const stored = (
    overrides: Partial<{
      responseStatus: number;
      responseBody: Record<string, unknown>;
      expiresAt: Date;
    }> = {},
  ) => ({
    responseStatus: 201,
    responseBody: { id: 'evt-1', status: 'received' },
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  const compositeKey = (organizationId: string, scope: string, key: string) => ({
    organizationId_scope_key: { organizationId, scope, key },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config.get.mockReturnValue(undefined); // default TTL
    service = new IdempotencyService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
    );
  });

  describe('fast path (replay)', () => {
    it('serves a non-expired stored response without invoking op', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(stored());

      const result = await service.execute(ORG, 'event-submission', 'k-1', op);

      expect(op).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 201,
        body: { id: 'evt-1', status: 'received' },
      });
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenCalledWith({
        where: compositeKey(ORG, 'event-submission', 'k-1'),
      });
    });
  });

  describe('store path (miss)', () => {
    it('runs op, persists its response in the same transaction, and returns it', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      tx.idempotencyRecord.create.mockResolvedValue({});

      const result = await service.execute(ORG, 'event-submission', 'k-1', op);

      expect(op).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.idempotencyRecord.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: ORG,
          scope: 'event-submission',
          key: 'k-1',
          responseStatus: 201,
          responseBody: { id: 'evt-1', status: 'received' },
          expiresAt: expect.any(Date),
        }),
      });
      expect(result).toEqual({
        status: 201,
        body: { id: 'evt-1', status: 'received' },
      });
    });

    it('propagates the error and leaves no record when op fails before commit', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      const boom = new Error('advisory lock failed');
      op.mockRejectedValueOnce(boom);

      await expect(
        service.execute(ORG, 'event-submission', 'k-1', op),
      ).rejects.toThrow(boom);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.idempotencyRecord.create).not.toHaveBeenCalled();
    });
  });

  describe('expiry', () => {
    it('deletes the still-expired row, reruns op, and replaces the record', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(
        stored({ expiresAt: new Date(Date.now() - 1_000) }),
      );
      tx.idempotencyRecord.deleteMany.mockResolvedValue({ count: 1 });
      tx.idempotencyRecord.create.mockResolvedValue({});

      const result = await service.execute(ORG, 'sub', 'k-expired', op);

      // The expired row must be made absent before the create, or the reuse
      // would P2002 against UNIQUE (organization_id, scope, key) and serve the
      // old response.
      expect(tx.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG,
          scope: 'sub',
          key: 'k-expired',
          expiresAt: { lt: expect.any(Date) },
        },
      });
      expect(op).toHaveBeenCalledTimes(1);
      expect(tx.idempotencyRecord.create).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(201);
    });

    it('does not delete a fresh record when a concurrent winner commits mid-flight', async () => {
      // Pre-check sees the expired row; by the time our transaction opens, a
      // winner has inserted a fresh record. deleteMany's expiresAt filter must
      // leave it alone (then create → P2002 → the fresh winner is served).
      prisma.idempotencyRecord.findUnique
        .mockResolvedValueOnce(
          stored({ expiresAt: new Date(Date.now() - 1_000) }), // pre-check
        )
        .mockResolvedValueOnce(
          stored({ responseStatus: 200, responseBody: { id: 'evt-winner', status: 'received' } }),
        ); // winner read
      tx.idempotencyRecord.deleteMany.mockResolvedValue({ count: 0 });
      tx.idempotencyRecord.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      const result = await service.execute(ORG, 'sub', 'k-expired-race', op);

      expect(tx.idempotencyRecord.deleteMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG,
          scope: 'sub',
          key: 'k-expired-race',
          expiresAt: { lt: expect.any(Date) },
        },
      });
      expect(result).toEqual({
        status: 200,
        body: { id: 'evt-winner', status: 'received' },
      });
    });
  });

  describe('race (unique-violation)', () => {
    it('serves the winner stored response after a P2002 and does not error', async () => {
      prisma.idempotencyRecord.findUnique
        .mockResolvedValueOnce(null) // pre-check miss
        .mockResolvedValueOnce(
          stored({
            responseStatus: 200,
            responseBody: { id: 'evt-winner', status: 'received' },
          }),
        ); // winner read
      tx.idempotencyRecord.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.19.3',
        }),
      );

      const result = await service.execute(ORG, 'event-submission', 'k-race', op);

      // The loser's op ran inside the aborted transaction; the winner's response
      // is served with no second insert.
      expect(op).toHaveBeenCalledTimes(1);
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenNthCalledWith(2, {
        where: compositeKey(ORG, 'event-submission', 'k-race'),
      });
      expect(result).toEqual({
        status: 200,
        body: { id: 'evt-winner', status: 'received' },
      });
    });
  });

  describe('scope isolation', () => {
    it('does not dedupe the same key across different scopes', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      tx.idempotencyRecord.create.mockResolvedValue({});

      await service.execute(ORG, 'scope-a', 'k', op);
      await service.execute(ORG, 'scope-b', 'k', op);

      expect(op).toHaveBeenCalledTimes(2);
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenNthCalledWith(1, {
        where: compositeKey(ORG, 'scope-a', 'k'),
      });
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenNthCalledWith(2, {
        where: compositeKey(ORG, 'scope-b', 'k'),
      });
    });
  });

  describe('organization isolation', () => {
    it('looks records up per organization, not by key alone', async () => {
      prisma.idempotencyRecord.findUnique.mockResolvedValue(null);
      tx.idempotencyRecord.create.mockResolvedValue({});

      await service.execute(ORG, 'event-submission', 'k', op);
      await service.execute(OTHER_ORG, 'event-submission', 'k', op);

      // Both ran: a key used by one organization must not suppress the other's
      // operation, and must never serve the other's stored response body.
      expect(op).toHaveBeenCalledTimes(2);
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenNthCalledWith(1, {
        where: compositeKey(ORG, 'event-submission', 'k'),
      });
      expect(prisma.idempotencyRecord.findUnique).toHaveBeenNthCalledWith(2, {
        where: compositeKey(OTHER_ORG, 'event-submission', 'k'),
      });
      expect(tx.idempotencyRecord.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({ organizationId: ORG, key: 'k' }),
      });
      expect(tx.idempotencyRecord.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({ organizationId: OTHER_ORG, key: 'k' }),
      });
    });

    it('does not replay one organization’s stored response into another', async () => {
      // The other organization has a record; this organization's lookup misses.
      prisma.idempotencyRecord.findUnique.mockImplementation(
        async ({ where }: { where: { organizationId_scope_key: { organizationId: string } } }) =>
          where.organizationId_scope_key.organizationId === OTHER_ORG ? stored() : null,
      );
      tx.idempotencyRecord.create.mockResolvedValue({});

      const result = await service.execute(ORG, 'event-submission', 'k', op);

      expect(op).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: 201,
        body: { id: 'evt-1', status: 'received' },
      });
    });
  });
});
