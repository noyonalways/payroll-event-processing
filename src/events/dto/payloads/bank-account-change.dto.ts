import { IsDateString, IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Payload for BANK_ACCOUNT_CHANGE events.
 */
export class BankAccountChangePayloadDto {
  @IsString({ message: 'employeeId must be a string' })
  @IsNotEmpty({ message: 'employeeId is required' })
  employeeId!: string;

  @IsDateString({}, { message: 'effectiveDate must be an ISO-8601 date string' })
  effectiveDate!: string;

  @Matches(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/, {
    message: 'iban must be a valid IBAN (e.g. DE89 3704 0044 0532 0130 00)',
  })
  iban!: string;
}