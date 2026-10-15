import { ApiProperty } from '@nestjs/swagger';
// The shape is owned once, in @repo/shared (design D2); this decorated class is
// its Swagger face in core.
import { ErrorResponseBody } from '@repo/shared';

/**
 * Structured error body produced by the global HttpExceptionFilter.
 *
 * `message` is a plain string for simple errors (e.g. a missing Idempotency-Key)
 * or an array of `"field: message"` strings for class-validator failures.
 */
export class ErrorResponseDto implements ErrorResponseBody {
  @ApiProperty({ example: 400, description: 'HTTP status code' })
  statusCode!: number;

  @ApiProperty({
    description:
      'Human-readable error message, or a list of per-field messages for validation failures',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: [
      'iban: iban must be a valid IBAN (e.g. DE89 3704 0044 0532 0130 00)',
      'effectiveDate: effectiveDate must be an ISO-8601 date string',
    ],
  })
  message!: string | string[];

  @ApiProperty({ example: 'BadRequestException', description: 'Exception class name' })
  error!: string;

  @ApiProperty({ example: '2026-08-24T10:15:30.000Z', description: 'ISO-8601 timestamp' })
  timestamp!: string;

  @ApiProperty({ example: '/events', description: 'Request path' })
  path!: string;
}