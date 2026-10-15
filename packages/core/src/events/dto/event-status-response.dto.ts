import { ApiProperty } from '@nestjs/swagger';
import { EventAttemptDto } from './event-attempt.dto';
import {
  EVENT_LIFECYCLE_STATUSES,
  EventLifecycleStatus,
} from './event-lifecycle';

/**
 * Response body of GET /events/{id} (event-status-api): the event's current
 * committed lifecycle state, its details, and the attempt history.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class EventStatusResponseDto {
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
    description:
      'Current lifecycle status. With the transactional claim, `processing` is ' +
      'only observable inside a live transaction — polling clients see `queued` ' +
      'or a terminal state.',
  })
  status!: EventLifecycleStatus;

  @ApiProperty({
    example: {
      employeeId: 'emp-1',
      effectiveDate: '2026-09-01',
      iban: 'DE89370400440532013000',
    },
    description: 'Submitted payload for the event type',
  })
  payload!: Record<string, unknown>;

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

  @ApiProperty({
    example: { reference: 'SIM-external-payroll-op:req', affectedFields: { iban: 'DE89...' } },
    nullable: true,
    description: 'Handler result stored on success; null otherwise',
  })
  result!: Record<string, unknown> | null;

  @ApiProperty({
    type: () => [EventAttemptDto],
    description:
      'Processing attempts from `event_attempts`, ascending by attemptNumber. ' +
      'Empty for events that no attempt has run for yet.',
  })
  attempts!: EventAttemptDto[];
}