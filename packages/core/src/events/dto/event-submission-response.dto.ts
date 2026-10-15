import { ApiProperty } from '@nestjs/swagger';

/**
 * Immediate HTTP response for an accepted event submission (POST /events -> 201).
 *
 * This is the stored body: duplicate submissions with the same Idempotency-Key
 * replay the exact same response.
 */
export class EventSubmissionResponseDto {
  @ApiProperty({
    description: 'Unique event identifier',
    example: 'f3c6df52-9d13-4d7b-a2d1-9f8d4c2c8a9b',
  })
  id!: string;

  @ApiProperty({
    description:
      'Event status at submission time. Advances as the event moves through async processing.',
    example: 'received',
    enum: ['received'],
  })
  status!: 'received';
}