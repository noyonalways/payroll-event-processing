import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Payload for BANK_ACCOUNT_CHANGE events.
 */
export class BankAccountChangePayloadDto {
  @ApiProperty({ description: 'Employee identifier', example: 'emp-123' })
  @IsString({ message: 'employeeId must be a string' })
  @IsNotEmpty({ message: 'employeeId is required' })
  employeeId!: string;

  @ApiProperty({
    description: 'Effective date (ISO-8601)',
    example: '2026-09-01',
    format: 'date',
  })
  @IsDateString({}, { message: 'effectiveDate must be an ISO-8601 date string' })
  effectiveDate!: string;

  @ApiProperty({
    description: 'IBAN account number',
    example: 'DE89370400440532013000',
    pattern: '^[A-Z]{2}\\d{2}[A-Z0-9]{11,30}$',
  })
  @Matches(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, {
    message: 'iban must be a valid IBAN (e.g. DE89 3704 0044 0532 0130 00)',
  })
  iban!: string;
}