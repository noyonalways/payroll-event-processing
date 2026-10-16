import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { EmployeeResponseDto } from './employee-response.dto';

/**
 * Page size served when the caller does not ask for one (employee-directory
 * design D6) — directories are scanned by people, so a roomier default than
 * the events feed suits the use.
 */
export const DEFAULT_EMPLOYEE_PAGE_LIMIT = 50;
/** Largest page size accepted — anything above is a structured 400. */
export const MAX_EMPLOYEE_PAGE_LIMIT = 100;

/**
 * Query parameters of GET /employees — combinable filters plus pagination
 * (design D6). Filters AND together and compose with the cursor: a cursor
 * continues the currently filtered selection. The global ValidationPipe
 * (whitelist + forbidNonWhitelisted) rejects undeclared parameters with a
 * structured 400.
 */
export class EmployeesListQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Restrict to active (true) or archived (false) employees. Omitted: return both.',
    example: true,
  })
  // NOTE: declared as boolean|string and gated by @IsIn — the global pipe's
  // implicit Boolean conversion would coerce ANY non-empty string (including
  // 'false') to `true`, silently inverting the filter. The wire must be one of
  // the two literal spellings (or a real boolean); the service normalizes it.
  @IsOptional()
  @IsIn([true, false, 'true', 'false'], { message: 'active must be a boolean' })
  active?: boolean | string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring match over the employee number and name.',
    example: 'ada',
  })
  @IsOptional()
  @IsString({ message: 'search must be a string' })
  search?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_EMPLOYEE_PAGE_LIMIT,
    default: DEFAULT_EMPLOYEE_PAGE_LIMIT,
    description: `Page size (1-${MAX_EMPLOYEE_PAGE_LIMIT}). Defaults to ${DEFAULT_EMPLOYEE_PAGE_LIMIT} when omitted.`,
    example: DEFAULT_EMPLOYEE_PAGE_LIMIT,
  })
  @IsOptional()
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(MAX_EMPLOYEE_PAGE_LIMIT, { message: `limit must be at most ${MAX_EMPLOYEE_PAGE_LIMIT}` })
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Opaque pagination token from a previous page’s `nextCursor`. ' +
      'An unparsable value is rejected with 400, not treated as absent.',
  })
  @IsOptional()
  @IsString({ message: 'cursor must be a string' })
  cursor?: string;
}

/**
 * One entry of the directory page. Same shape as the single-employee
 * representation — a directory row is small, so no lighter projection is
 * warranted (events use one because payloads and attempt trails are heavy;
 * employees carry six fields).
 */
export type EmployeeListItemDto = EmployeeResponseDto;

/**
 * Body of GET /employees: one explicit page of the caller's directory,
 * ordered by employee number ascending (design D6 — a roster, not a feed).
 * `nextCursor` is `null` when no further page exists.
 */
export class EmployeesListResponseDto {
  @ApiProperty({
    type: () => [EmployeeResponseDto],
    description: 'The employees matching the request, ordered by employee number.',
  })
  data!: EmployeeListItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opaque pagination token for the next page, to pass back as `cursor`. ' +
      'Null when no further page exists.',
  })
  nextCursor!: string | null;

  @ApiProperty({
    example: DEFAULT_EMPLOYEE_PAGE_LIMIT,
    description: 'The page size requested for this page (capped at the maximum).',
  })
  limit!: number;
}
