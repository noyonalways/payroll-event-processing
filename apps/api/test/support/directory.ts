import { PrismaService } from '@repo/database';

/**
 * Shared employee-directory support for the e2e suites.
 *
 * Suites that exercise the EVENT pipeline (submission, queue, processing,
 * history) only need their employee `employeeId`s to be VALID for the
 * submission gate — these helpers write directory rows straight through the
 * store, which keeps fixture setup one-off and independent of the employees
 * CRUD surface (a breakage there fails the directory's own suites loudly, not
 * the event suites).
 *
 * Numbers are name-spaced per call-site prefix so suites can run in any order
 * and repeatedly against the same database without colliding.
 */
export interface DirectoryEmployeeOptions {
  name?: string | null;
  department?: string | null;
  /** Defaults to an ACTIVE employee. Pass false to seed an archived one. */
  active?: boolean;
}

/** Creates (upsert) one directory employee for the organization. */
export async function ensureEmployee(
  prisma: PrismaService,
  organizationId: string,
  employeeNumber: string,
  options: DirectoryEmployeeOptions = {},
): Promise<{ id: string; employeeNumber: string; active: boolean }> {
  const data = {
    name: options.name ?? `E2E ${employeeNumber}`,
    department: options.department ?? null,
    active: options.active ?? true,
  };
  const existing = await prisma.employee.findUnique({
    where: { organizationId_employeeNumber: { organizationId, employeeNumber } },
    select: { id: true, active: true },
  });
  if (existing) {
    if (existing.active !== data.active) {
      await prisma.employee.update({
        where: { id: existing.id },
        data: { active: data.active },
      });
    }
    return { id: existing.id, employeeNumber, active: data.active };
  }
  const created = await prisma.employee.create({
    data: { organizationId, employeeNumber, ...data },
    select: { id: true, employeeNumber: true, active: true },
  });
  return created;
}

/**
 * Pre-creates a pool of ACTIVE employees and returns a synchronous drawer:
 * payload builders in the event suites stay one-line sync calls
 * (`employeeId: employee()`), while every handed-out number is guaranteed to
 * pass the submission gate.
 */
export function employeePool(
  employees: string[],
): () => string {
  let index = 0;
  return () => {
    if (index >= employees.length) {
      throw new Error(
        'employee pool exhausted — raise the pool size for this suite',
      );
    }
    const next = employees[index];
    index += 1;
    return next;
  };
}

/** Seeds `count` active employees with the prefix and returns the pool drawer. */
export async function seedEmployeePool(
  prisma: PrismaService,
  organizationId: string,
  prefix: string,
  count: number,
  label = 'pool',
): Promise<() => string> {
  const numbers = Array.from(
    { length: count },
    (_, i) => `${prefix}-${label}-${String(i).padStart(3, '0')}`,
  );
  for (const number of numbers) {
    await ensureEmployee(prisma, organizationId, number);
  }
  return employeePool(numbers);
}

import { randomUUID } from 'crypto';

/**
 * Per-tenant employee directory fixture for suites that submit events: the
 * submission gate only accepts payload employeeIds that exist as ACTIVE
 * directory employees of the submitting organization, so every id a suite
 * mints must be backed by a row.
 *
 * Suites keep their readable per-case prefixes (`employee('seq')`,
 * `` `queued-${…}` ``) and draw PRE-CREATED numbers keyed by prefix — the
 * signatures and call sites stay untouched, the numbers just become
 * gate-valid. Seed generously; drawing from an empty pool fails loudly
 * instead of submitting an id the gate would 422.
 */
export class DirectoryEmployees {
  private pools = new Map<string, string[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationId: string,
  ) {}

  /** Pre-creates `count` ACTIVE (gate-valid) employees under `prefix`. */
  async seed(prefix: string, count: number): Promise<void> {
    const numbers = await Promise.all(
      Array.from({ length: count }, async () => {
        const number = `${prefix}-${randomUUID().slice(0, 12)}`;
        await ensureEmployee(this.prisma, this.organizationId, number);
        return number;
      }),
    );
    this.pools.set(prefix, numbers);
  }

  /** Takes one pre-created number for `prefix` (created if never seeded). */
  draw = (prefix = 'emp'): string => {
    const pool = this.pools.get(prefix);
    if (!pool || pool.length === 0) {
      throw new Error(
        `employee pool "${prefix}" exhausted — seed() more for this suite`,
      );
    }
    return pool.shift()!;
  };
}
