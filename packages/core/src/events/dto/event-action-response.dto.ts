import { ApiProperty } from '@nestjs/swagger';
import { EventLifecycleStatus } from './event-lifecycle';

/**
 * Response body of the recovery actions `POST /events/{id}/retry` and
 * `POST /events/{id}/cancel` (event-recovery design D7): exactly the fields the
 * UI needs to update a row in place — the event id, its NEW lifecycle status,
 * and the identity fields a list row displays. Not the full status contract
 * (that is GET /events/{id}'s); an action reply stays light by design.
 *
 * A class (not an interface) is required so Swagger can introspect the schema.
 */
export class EventActionResponseDto {
  @ApiProperty({
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
    description: 'Unique event identifier',
  })
  id!: string;

  @ApiProperty({
    example: 'queued',
    description:
      'The event’s lifecycle status AFTER the action (`queued` for a retry, ' +
      '`cancelled` for a cancel).',
  })
  status!: EventLifecycleStatus;

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
}
