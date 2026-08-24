import { IsDateString, IsNotEmpty, IsNumber, IsPositive, IsString, Length } from 'class-validator';

/**
 * Payload for SALARY_CHANGE events.
 */
export class SalaryChangePayloadDto {
  @IsString({ message: 'employeeId must be a string' })
  @IsNotEmpty({ message: 'employeeId is required' })
  employeeId!: string;

  @IsDateString({}, { message: 'effectiveDate must be an ISO-8601 date string' })
  effectiveDate!: string;

  @IsNumber({}, { message: 'newSalary must be a number' })
  @IsPositive({ message: 'newSalary must be a positive number' })
  newSalary!: number;

  @IsString({ message: 'currency must be a string' })
  @IsNotEmpty({ message: 'currency is required' })
  @Length(3, 3, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency!: string;
}