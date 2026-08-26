import { ApiProperty } from '@nestjs/swagger';

/**
 * One terminal processing attempt from the append-only `event_attempts` audit
 * trail, as returned by GET /events/{id} (event-status-api). A SUCCESS attempt
 * carries `result`; a FAILED attempt carries `errorType` + `failedReason`;
 * the other fields are null.
 */
export class EventAttemptDto {
  @ApiProperty({
    example: 1,
    description: '1-based attempt number within the event lifecycle',
  })
  attemptNumber!: number;

  @ApiProperty({
    enum: ['SUCCESS', 'FAILED'],
    example: 'SUCCESS',
    description: 'Terminal outcome committed by this attempt',
  })
  status!: 'SUCCESS' | 'FAILED';

  @ApiProperty({
    enum: ['TEMPORARY', 'PERMANENT'],
    example: 'TEMPORARY',
    nullable: true,
    description:
      'Failure category — TEMPORARY = retries exhausted after transient failures, ' +
      'PERMANENT = business rejection. null for successful attempts.',
  })
  errorType!: 'TEMPORARY' | 'PERMANENT' | null;

  @ApiProperty({
    example: 'Simulated provider rejected the change',
    nullable: true,
    description: 'Why the attempt failed. null for successful attempts.',
  })
  failedReason!: string | null;

  @ApiProperty({
    example: { reference: 'SIM-external-payroll-op:req', affectedFields: { iban: 'DE89...' } },
    nullable: true,
    description:
      'Handler result of the simulated external operation. null for failed attempts.',
  })
  result!: Record<string, unknown> | null;

  @ApiProperty({
    example: '2026-08-26T00:40:12.000Z',
    description: 'ISO-8601 timestamp of the attempt row (committed with the terminal transition)',
  })
  createdAt!: string;
}