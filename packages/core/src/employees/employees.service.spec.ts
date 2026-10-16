import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EmployeesService, decodeEmployeeListCursor, encodeEmployeeListCursor } from './employees.service';
import { DEFAULT_EMPLOYEE_PAGE_LIMIT, MAX_EMPLOYEE_PAGE_LIMIT } from './dto/employees-list.dto';
import { PrismaService } from '@repo/database';
import { CreateEmployeeDto } from './dto/create-employee.dto';

const ORG = 'org-a';
const OTHER_ORG = 'org-b';

/** House shape for the store's unique-violation (see auth.service.spec). */
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: ['organization_id', 'employee_number'] },
  });

/** A row exactly as Prisma's create/findFirst/findMany returns it. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'emp-row-1',
  organizationId: ORG,
  employeeNumber: 'emp-001',
  name: 'Ada Lovelace',
  department: 'Engineering',
  active: true,
  createdAt: new Date('2026-10-16T09:00:00.000Z'),
  updatedAt: new Date('2026-10-16T09:00:01.000Z'),
  ...overrides,
});

describe('EmployeesService', () => {
  let service: EmployeesService;

  const prisma = {
    employee: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const dto = (overrides: Partial<CreateEmployeeDto> = {}): CreateEmployeeDto => ({
    employeeNumber: 'emp-002',
    name: 'Grace Hopper',
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.employee.create.mockResolvedValue(row());
    prisma.employee.findFirst.mockResolvedValue(null);
    prisma.employee.findMany.mockResolvedValue([]);
    prisma.employee.update.mockImplementation(async ({ where }: { where: { id: string } }) =>
      row({ id: where.id }),
    );
    prisma.employee.updateMany.mockResolvedValue({ count: 1 });
    service = new EmployeesService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('creates an active employee inside the caller’s organization', async () => {
      const result = await service.create(ORG, dto({ department: 'People' }));

      expect(prisma.employee.create).toHaveBeenCalledWith({
        data: {
          organizationId: ORG,
          employeeNumber: 'emp-002',
          name: 'Grace Hopper',
          department: 'People',
          active: true,
        },
      });
      expect(result).toEqual({
        id: 'emp-row-1',
        employeeNumber: 'emp-001',
        name: 'Ada Lovelace',
        department: 'Engineering',
        active: true,
        createdAt: '2026-10-16T09:00:00.000Z',
        updatedAt: '2026-10-16T09:00:01.000Z',
      });
    });

    it('maps the store’s P2002 to a 409 — the unique constraint is the arbiter', async () => {
      prisma.employee.create.mockRejectedValue(uniqueViolation());

      await expect(service.create(ORG, dto())).rejects.toBeInstanceOf(ConflictException);
      // Nothing else was attempted — one create, no reads after the failure.
      expect(prisma.employee.findFirst).not.toHaveBeenCalled();
    });

    it('trims padded input and rejects values that are blank after trimming', async () => {
      await service.create(ORG, dto({ employeeNumber: '  emp-009 ', name: '  Grace  ' }));

      expect(prisma.employee.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ employeeNumber: 'emp-009', name: 'Grace' }),
      });

      // Whitespace-only fields are the same rejection as missing ones (the
      // pipe cannot reliably trim — the service normalizes explicitly).
      await expect(service.create(ORG, dto({ employeeNumber: '   ', name: 'X' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.create(ORG, dto({ name: '\t' }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.employee.create).toHaveBeenCalledTimes(1); // only the first succeeded in-store
    });

    it('lets unexpected store errors surface', async () => {
      prisma.employee.create.mockRejectedValue(new Error('boom'));
      await expect(service.create(ORG, dto())).rejects.toThrow('boom');
    });
  });

  describe('list (keyset by employee number, design D6)', () => {
    it('scopes to the caller’s organization, takes limit+1, orders by employee number', async () => {
      prisma.employee.findMany.mockResolvedValue([row()]);

      const result = await service.list(ORG, { limit: 5 });

      const args = prisma.employee.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ organizationId: ORG });
      expect(args.orderBy).toEqual([{ employeeNumber: 'asc' }]);
      expect(args.take).toBe(6);
      expect(result.limit).toBe(5);
      // Every served row fit: no further page.
      expect(result.nextCursor).toBeNull();
    });

    it('defaults the page size to 50 and caps the maximum', async () => {
      prisma.employee.findMany.mockResolvedValue([]);

      await service.list(ORG, {});
      await service.list(ORG, { limit: MAX_EMPLOYEE_PAGE_LIMIT });

      expect(prisma.employee.findMany.mock.calls[0][0].take).toBe(
        DEFAULT_EMPLOYEE_PAGE_LIMIT + 1,
      );
      expect(prisma.employee.findMany.mock.calls[1][0].take).toBe(MAX_EMPLOYEE_PAGE_LIMIT + 1);
    });

    it('AND-composes the active and search filters into ONE where', async () => {
      prisma.employee.findMany.mockResolvedValue([]);

      await service.list(ORG, { active: false, search: 'ada' });

      const args = prisma.employee.findMany.mock.calls[0][0];
      expect(args.where).toMatchObject({
        organizationId: ORG,
        active: false,
        OR: [
          { employeeNumber: { contains: 'ada', mode: 'insensitive' } },
          { name: { contains: 'ada', mode: 'insensitive' } },
        ],
      });
    });

    it('seeks strictly after the cursor’s employee number and emits the next cursor from the last served row', async () => {
      const cursor = encodeEmployeeListCursor({ employeeNumber: 'emp-004' });
      // A full page PLUS one fill row (the store was asked for limit+1): the
      // third row proves hasMore without being served.
      prisma.employee.findMany.mockResolvedValue([
        row({ employeeNumber: 'emp-007' }),
        row({ employeeNumber: 'emp-009' }),
        row({ employeeNumber: 'emp-010' }),
      ]);

      const result = await service.list(ORG, { limit: 2, cursor });

      const args = prisma.employee.findMany.mock.calls[0][0];
      // Seek on the unique index alone: no tie, no tiebreaker needed.
      expect(args.where.employeeNumber).toEqual({ gt: 'emp-004' });
      expect(JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString('utf8'))).toEqual({
        v: 1,
        n: 'emp-009',
      });
    });

    it('normalizes the wire spellings of active and rejects anything else', async () => {
      prisma.employee.findMany.mockResolvedValue([]);

      await service.list(ORG, { active: 'false' as unknown as boolean });
      // 'false' the string must query FALSE, never the implicit-conversion true.
      expect(prisma.employee.findMany.mock.calls[0][0].where.active).toBe(false);

      await expect(
        service.list(ORG, { active: 'not-a-boolean' as unknown as boolean }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an undecodable or foreign cursor as a structured 400 before querying', async () => {
      await expect(service.list(ORG, { cursor: '@@no@@' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      // A cursor minted for the events list carries t/i, not n — foreign.
      await expect(
        service.list(ORG, {
          cursor: Buffer.from(JSON.stringify({ v: 1, t: '2026-10-16T00:00:00.000Z', i: 'evt-1' })).toString('base64url'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.employee.findMany).not.toHaveBeenCalled();
    });

    it('moves the cursor to the last row only when a further row exists', async () => {
      prisma.employee.findMany.mockResolvedValue([row(), row({ id: 'e2' })]);
      const full = await service.list(ORG, { limit: 1 });
      expect(JSON.parse(Buffer.from(full.nextCursor!, 'base64url').toString('utf8'))).toEqual({
        v: 1,
        n: 'emp-001',
      });

      prisma.employee.findMany.mockResolvedValue([row()]);
      const last = await service.list(ORG, { limit: 1 });
      expect(last.nextCursor).toBeNull();

      // Round-trips through its own encoder.
      const c = decodeEmployeeListCursor(full.nextCursor!);
      expect(c).toEqual({ v: 1, n: 'emp-001' });
    });
  });

  describe('get / update / archive (design D4/D5)', () => {
    it('reads one record within the organization; unknown and foreign ids are the same 404', async () => {
      prisma.employee.findFirst.mockResolvedValue(row());
      await service.get(ORG, 'emp-row-1');
      expect(prisma.employee.findFirst).toHaveBeenCalledWith({
        where: { id: 'emp-row-1', organizationId: ORG },
      });

      prisma.employee.findFirst.mockResolvedValue(null);
      await expect(service.get(ORG, 'nope')).rejects.toBeInstanceOf(NotFoundException);
      // Another organization's record: the tenant-filtered lookup returns
      // nothing, so the caller learns only that it is absent.
      await expect(service.get(OTHER_ORG, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('updates only the declared fields and cannot touch the employee number', async () => {
      prisma.employee.findFirst.mockResolvedValue(row());

      const result = await service.update(ORG, 'emp-row-1', { department: 'People', active: false });

      expect(prisma.employee.update).toHaveBeenCalledWith({
        where: { id: 'emp-row-1' },
        data: { department: 'People', active: false },
      });
      expect(result.employeeNumber).toBe('emp-001');
    });

    it('throws 404 for an update of a record outside the tenant boundary', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);
      await expect(service.update(OTHER_ORG, 'r1', { name: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.employee.update).not.toHaveBeenCalled();
    });

    it('archives through a guarded updateMany and is idempotent for an already-archived row', async () => {
      prisma.employee.findFirst.mockResolvedValue(row({ active: true }));
      await service.archive(ORG, 'emp-row-1');
      expect(prisma.employee.updateMany).toHaveBeenCalledWith({
        where: { id: 'emp-row-1', organizationId: ORG },
        data: { active: false },
      });

      // Row already archived: count 0 — still a success, never an error.
      prisma.employee.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.archive(ORG, 'emp-row-1')).resolves.toBeUndefined();
    });

    it('rejects an archive of an unknown or foreign record with 404', async () => {
      prisma.employee.findFirst.mockResolvedValue(null);
      await expect(service.archive(ORG, 'nope')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.employee.updateMany).not.toHaveBeenCalled();
    });
  });
});
