import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsNotEmpty, IsNumber, IsPositive, IsString, Length } from 'class-validator';

/**
 * Payload for SALARY_CHANGE events.
 */
export class SalaryChangePayloadDto {
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
    type: Number,
    description: 'New annual salary (positive number)',
    example: 75000,
    minimum: 0,
  })
  @IsNumber({}, { message: 'newSalary must be a number' })
  @IsPositive({ message: 'newSalary must be a positive number' })
  newSalary!: number;

  @ApiProperty({
    description: 'ISO 4217 three-letter currency code',
    example: 'EUR',
    minLength: 3,
    maxLength: 3,
  })
  @IsString({ message: 'currency must be a string' })
  @IsNotEmpty({ message: 'currency is required' })
  @Length(3, 3, { message: 'currency must be a 3-letter ISO 4217 code' })
  currency!: string;
}