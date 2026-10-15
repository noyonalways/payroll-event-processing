import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { EventType } from '@repo/shared';
import {
  EVENT_LIFECYCLE_STATUSES,
  EventLifecycleStatus,
} from './event-lifecycle';

/** Page size served when the caller does not ask for one (design D4). */
export const DEFAULT_PAGE_LIMIT = 20;
/** Largest page size accepted — anything above is a structured 400. */
export const MAX_PAGE_LIMIT = 100;

/**
 * One row of the event history page (events-query-api): the identity, shape,
 * and timing of an event WITHOUT payload contents, attempt trail, or processing
 * results — those are the single-event endpoint's contract, and leaving them
 * out keeps 100-row pages from carrying megabytes of JSON.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class EventListItemDto {
  @ApiProperty({
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
    description: 'Unique event identifier',
  })
  id!: string;

  @ApiProperty({
    example: 'BANK_ACCOUNT_CHANGE',
    description: 'Submitted event type',
  })
  eventType!: string;

  @ApiProperty({
    example: 'emp-1',
    description: 'Employee the event belongs to',
  })
  employeeId!: string;

  @ApiProperty({
    example: 1,
    description: 'Per-employee monotonic sequence (Number, not BigInt)',
  })
  sequence!: number;

  @ApiProperty({
    enum: EVENT_LIFECYCLE_STATUSES,
    example: 'queued',
    description: 'Current lifecycle status (wire format, lowercase).',
  })
  status!: EventLifecycleStatus;

  @ApiProperty({
    example: '2026-08-26T00:40:12.000Z',
    description: 'ISO-8601 event creation timestamp',
  })
  createdAt!: string;

  @ApiProperty({
    example: '2026-08-26T00:40:13.000Z',
    description: 'ISO-8601 last-update timestamp',
  })
  updatedAt!: string;

  @ApiProperty({
    example: '2026-08-26T00:40:13.000Z',
    nullable: true,
    description: 'ISO-8601 timestamp of the terminal `success` write; null otherwise',
  })
  processedAt!: string | null;
}

/**
 * Body of GET /events: one explicit page of the caller's event history.
 * `nextCursor` is an opaque token for the next page — `null` when no further
 * page exists — so clients page forward without seeing database internals.
 */
export class EventListResponseDto {
  @ApiProperty({
    type: () => [EventListItemDto],
    description: 'The events matching the request, newest first.',
  })
  data!: EventListItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Opaque pagination token for the next page, to pass back as `cursor`. ' +
      'Null when no further page exists.',
  })
  nextCursor!: string | null;

  @ApiProperty({
    example: DEFAULT_PAGE_LIMIT,
    description: 'The page size requested for this page (capped at the maximum).',
  })
  limit!: number;
}

/**
 * Query parameters of GET /events — the combinable filters plus the pagination
 * controls. Every accepted parameter is declared here: the global ValidationPipe
 * (whitelist + forbidNonWhitelisted) rejects an undeclared query parameter with
 * a structured 400, which is the desired over-sharing failure mode (design D4).
 *
 * Filters combine with AND and compose with the cursor: a cursor continues the
 * currently filtered selection rather than restarting the unfiltered query.
 * Date bounds are inclusive at both ends.
 */
export class EventsListQueryDto {
  @ApiPropertyOptional({
    enum: EVENT_LIFECYCLE_STATUSES,
    description: 'Filter by lifecycle status.',
    example: 'failed',
  })
  @IsOptional()
  @IsIn(EVENT_LIFECYCLE_STATUSES as readonly string[], {
    message:
      'status must be one of the lifecycle states: received, queued, processing, success, failed, cancelled',
  })
  status?: EventLifecycleStatus;

  @ApiPropertyOptional({
    enum: EventType,
    enumName: 'EventType',
    description: 'Filter by event type.',
    example: EventType.SALARY_CHANGE,
  })
  @IsOptional()
  @IsEnum(EventType, { message: 'eventType must be one of the supported event types' })
  eventType?: EventType;

  @ApiPropertyOptional({
    description:
      'Filter by the submitted employee id, matched within the caller’s organization.',
    example: 'emp-1',
  })
  @IsOptional()
  @IsString({ message: 'employeeId must be a string' })
  employeeId?: string;

  @ApiPropertyOptional({
    description:
      'Inclusive ISO-8601 lower bound on the event creation time.',
    example: '2026-08-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'createdAfter must be an ISO-8601 date-time string' })
  createdAfter?: string;

  @ApiPropertyOptional({
    description:
      'Inclusive ISO-8601 upper bound on the event creation time.',
    example: '2026-08-31T23:59:59.999Z',
  })
  @IsOptional()
  @IsISO8601({}, { message: 'createdBefore must be an ISO-8601 date-time string' })
  createdBefore?: string;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
    default: DEFAULT_PAGE_LIMIT,
    description: 'Page size. Defaults to 20 when omitted.',
    example: 20,
  })
  @IsOptional()
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(MAX_PAGE_LIMIT, { message: `limit must be at most ${MAX_PAGE_LIMIT}` })
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
