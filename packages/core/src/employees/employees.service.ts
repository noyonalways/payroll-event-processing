import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@repo/database';
import {
  DEFAULT_EMPLOYEE_PAGE_LIMIT,
  EmployeeListItemDto,
  EmployeesListQueryDto,
  EmployeesListResponseDto,
} from './dto/employees-list.dto';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { EmployeeResponseDto } from './dto/employee-response.dto';

/**
 * A pagination position: the employee number of the last row served. Versioned
 * so the encoding can evolve without silently misdialing old tokens. The
 * number alone is a unique seek key within the organization — the
 * UNIQUE (organization_id, employee_number) constraint guarantees no tie and
 * therefore no tiebreaker — so the cursor is tiny and the seek rides the
 * WITHIN-ORG unique index directly (design D6).
 */
interface EmployeeListCursor {
  v: number;
  /** Employee number of the last row of the previous page. */
  n: string;
}

const CURSOR_VERSION = 1;

/**
 * The opaque `nextCursor` for the page following `row`: base64url (URL-safe)
 * of the versioned position.
 */
export function encodeEmployeeListCursor(row: {
  employeeNumber: string;
}): string {
  const payload: EmployeeListCursor = { v: CURSOR_VERSION, n: row.employeeNumber };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a client-supplied cursor back into its seek position. An
 * undecodable, foreign, or corrupt token is a structured 400 — treating it as
 * "page one" would silently re-serve rows the client has already seen. A
 * cursor minted for the events list (which carries `t`/`i`, not `n`) fails
 * this decode and is rejected, never misinterpreted.
 */
export function decodeEmployeeListCursor(cursor: string): EmployeeListCursor {
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(decoded);
  } catch {
    throw new BadRequestException('cursor is not a valid employee-list cursor');
  }
  const c = parsed as Partial<EmployeeListCursor> | null;
  if (
    typeof c !== 'object' ||
    c === null ||
    c.v !== CURSOR_VERSION ||
    typeof c.n !== 'string' ||
    c.n.length === 0
  ) {
    throw new BadRequestException('cursor is not a valid employee-list cursor');
  }
  return c as EmployeeListCursor;
}

/**
 * The organization's employee directory, scoped to ONE organization.
 *
 * The tenant boundary is the first argument of every public method, so no call
 * site can read or write directory rows without naming the organization they
 * belong to. The organization comes from the verified access token (see
 * `JwtAuthGuard`); it is never accepted from the request body.
 *
 * Archive-not-delete (design D5): employees are never removed — `active` flips
 * to false, the unique constraint keeps the number reserved for that
 * organization, and the event history that references the number stays
 * interpretable forever.
 */
@Injectable()
export class EmployeesService {
  private readonly logger = new Logger(EmployeesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers one employee. The UNIQUE (organization_id, employee_number)
   * constraint is the arbiter of duplication (design D4): a concurrent create
   * of the same number inside the organization loses the race and reads as the
   * same 409 a second POST would — the store, not this code, decides.
   */
  async create(
    organizationId: string,
    dto: CreateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    try {
      const employeeNumber = dto.employeeNumber.trim();
      const name = dto.name.trim();
      // Whitespace-surrounded input counts as blank: normalized here (the
      // pipe's implicit conversions make decorator-level trimming
      // unreliable), so a trimmed-to-empty value is a structured 400, and a
      // padded-but-real number stores without its padding.
      if (!employeeNumber || !name) {
        throw new BadRequestException('employeeNumber and name must not be blank');
      }
      const row = await this.prisma.employee.create({
        data: {
          organizationId,
          employeeNumber,
          name,
          department: dto.department ?? null,
          active: true,
        },
      });
      this.logger.log(
        `Employee ${row.employeeNumber} registered in organization ${organizationId}`,
      );
      return this.toRepresentation(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The number already exists in THIS organization — including an
        // archived row: numbers stay reserved after archiving (design D5).
        throw new ConflictException(
          `An employee with employeeNumber "${dto.employeeNumber}" already exists in this organization`,
        );
      }
      throw error;
    }
  }

  /**
   * One page of the directory, ordered by employee number ASCENDING (design
   * D6 — a roster is scanned alphabetically, not newest-first), keyset-paginated
   * by exact seek on the per-organization unique index. Filters
   * (`active`, `search`) AND-compose into the same WHERE and the cursor
   * continues the CURRENTLY FILTERED selection.
   *
   * Strictly read-only: no create/update call exists on this path, nothing is
   * enqueued.
   */
  async list(
    organizationId: string,
    query: EmployeesListQueryDto,
  ): Promise<EmployeesListResponseDto> {
    const limit = query.limit ?? DEFAULT_EMPLOYEE_PAGE_LIMIT;
    // The wire's `active` can be a real boolean or one of its two literal
    // spellings — the DTO accepts exactly those, and this normalization is the
    // single shared implementation. Anything else reaching here is invalid.
    const rawActive = query.active;
    const active =
      rawActive === undefined
        ? undefined
        : typeof rawActive === 'boolean'
          ? rawActive
          : rawActive === 'true'
            ? true
            : rawActive === 'false'
              ? false
              : undefined;
    if (rawActive !== undefined && active === undefined) {
      throw new BadRequestException('active must be a boolean');
    }
    const seek = query.cursor ? decodeEmployeeListCursor(query.cursor) : null;

    const where: Prisma.EmployeeWhereInput = {
      organizationId,
      ...(active === undefined ? {} : { active }),
      // Case-insensitive substring over number and name, AND-composed (design
      // D6): a filtered index-range scan, fine at directory scale.
      ...(query.search
        ? {
            OR: [
              { employeeNumber: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      // "Strictly after the cursor" under employee_number ASC: the number is
      // unique per organization, so a bare > seek is exact — no ties, no
      // tiebreaker, and the position cannot shift when new employees register.
      ...(seek ? { employeeNumber: { gt: seek.n } } : {}),
    };

    const rows = await this.prisma.employee.findMany({
      where,
      orderBy: [{ employeeNumber: 'asc' }],
      // One extra row answers "is there a next page?" without a second count.
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      data: page.map((row) => this.toRepresentation(row)),
      nextCursor: hasMore ? encodeEmployeeListCursor(page[page.length - 1]) : null,
      limit,
    };
  }

  /**
   * One employee by record id, within the caller's organization. Another
   * organization's record reads as 404 — the same response as an unknown id —
   * so the endpoint cannot be used to probe which ids exist elsewhere.
   */
  async get(organizationId: string, id: string): Promise<EmployeeResponseDto> {
    const row = await this.prisma.employee.findFirst({
      where: { id, organizationId },
    });
    if (!row) {
      throw new NotFoundException(`Employee with id ${id} not found`);
    }
    return this.toRepresentation(row);
  }

  /**
   * Partial corrections. `employeeNumber` never reaches here — the DTO does
   * not declare it, and the global pipe rejects the property outright (design
   * D4). An unknown or foreign id is the same 404.
   */
  async update(
    organizationId: string,
    id: string,
    dto: Partial<Pick<CreateEmployeeDto, 'name' | 'department'>> & { active?: boolean },
  ): Promise<EmployeeResponseDto> {
    const row = await this.prisma.employee.findFirst({
      where: { id, organizationId },
    });
    if (!row) {
      throw new NotFoundException(`Employee with id ${id} not found`);
    }
    // Whitespace-only name corrections count as blank (same rule as create).
    const name = dto.name === undefined ? undefined : dto.name.trim();
    if (name !== undefined && !name) {
      throw new BadRequestException('name must not be blank');
    }
    const updated = await this.prisma.employee.update({
      where: { id },
      data: {
        ...(name === undefined ? {} : { name }),
        ...(dto.department === undefined ? {} : { department: dto.department }),
        ...(dto.active === undefined ? {} : { active: dto.active }),
      },
    });
    return this.toRepresentation(updated);
  }

  /**
   * Archive (design D5): a guarded `active → false` write, never a DELETE.
   * Idempotent by the same guard — re-archiving an archived employee is a
   * row-stable no-op that still answers success. The number stays reserved
   * (the unique constraint includes archived rows) and the event history that
   * references it is untouched.
   */
  async archive(organizationId: string, id: string): Promise<void> {
    const row = await this.prisma.employee.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundException(`Employee with id ${id} not found`);
    }
    await this.prisma.employee.updateMany({
      where: { id, organizationId },
      data: { active: false },
    });
  }

  /** Wire shape: BigInt-free, ISO strings, exactly the documented seven fields. */
  private toRepresentation(row: {
    id: string;
    employeeNumber: string;
    name: string | null;
    department: string | null;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): EmployeeListItemDto {
    return {
      id: row.id,
      employeeNumber: row.employeeNumber,
      name: row.name,
      department: row.department,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
