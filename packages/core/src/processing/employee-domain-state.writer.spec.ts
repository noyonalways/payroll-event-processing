import { Prisma } from '@prisma/client';
import { EmployeeDomainStateWriter } from './employee-domain-state.writer';

/**
 * Unit coverage for the state writer (domain-effects design D3/D1). The writer
 * is a thin mapper — the assertions pin the exact insert DATA it would send
 * through the claim's transaction client, and that a store-level uniqueness
 * rejection (P2002 on `source_event_id`) surfaces as an error: the writer must
 * never swallow the exactly-once arbiter, because a swallowed failure would
 * commit an event WITHOUT its state row.
 */
describe('EmployeeDomainStateWriter', () => {
  const tx = { employeeDomainState: { create: jest.fn() } };
  let writer: EmployeeDomainStateWriter;

  beforeEach(() => {
    jest.clearAllMocks();
    tx.employeeDomainState.create.mockResolvedValue({});
    writer = new EmployeeDomainStateWriter();
  });

  const APPEND = {
    organizationId: 'org-1',
    employeeId: 'emp-1',
    domain: 'COMPENSATION' as const,
    effectiveDate: '2026-09-01',
    value: { newSalary: 75000, currency: 'EUR' },
    sourceEventId: 'evt-1',
  };

  it('inserts exactly one row through the given transaction client with the exact field mapping', async () => {
    await writer.record(tx as unknown as Prisma.TransactionClient, APPEND);

    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
    expect(tx.employeeDomainState.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org-1',
        employeeId: 'emp-1',
        domain: 'COMPENSATION',
        value: { newSalary: 75000, currency: 'EUR' },
        effectiveDate: new Date('2026-09-01'),
        sourceEventId: 'evt-1',
      },
    });
  });

  it('rejects when the store rejects a second row for the same source event (P2002 surfaces, never swallowed)', async () => {
    tx.employeeDomainState.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the source event',
        { code: 'P2002', clientVersion: 'test' },
      ),
    );

    await expect(
      writer.record(tx as unknown as Prisma.TransactionClient, APPEND),
    ).rejects.toMatchObject({ code: 'P2002' });

    // One attempt only — no retry loop hides the uniqueness rejection.
    expect(tx.employeeDomainState.create).toHaveBeenCalledTimes(1);
  });
});
